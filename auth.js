// Portflow token management.
//
// Portflow (an LTI 1.3 tool) only signs Fontys users in when Canvas launches it, and
// hands the page an 8-hour bearer JWT in <body data-session="...">. There is no
// refresh endpoint. So to keep working without manual copying we replay that launch:
//
//   Canvas API token ──GET /login/session_token──► one-time Canvas web-login URL
//   ──► Canvas session cookie ──► Canvas tool page (LTI login form)
//   ──POST portfolio.drieam.app/lti/open_id──► Canvas OIDC authorize (cookie)
//   ──form_post id_token──► portfolio.drieam.app/lti/launches ──► HTML with data-session
//
// Token sources, in order:
//   1. PORTFLOW_TOKEN env var (manual override, never refreshed)
//   2. ~/.portflow-token if it has > REFRESH_MARGIN left
//   3. automatic Canvas launch, if a Canvas API token is configured
//      (CANVAS_API_TOKEN env var or ~/.canvas-token); result is saved to ~/.portflow-token

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_FILE = process.env.PORTFLOW_TOKEN_FILE || join(homedir(), ".portflow-token");
const CANVAS_TOKEN_FILE = process.env.CANVAS_TOKEN_FILE || join(homedir(), ".canvas-token");
const CANVAS_BASE = (process.env.CANVAS_BASE_URL || "https://fontysict.instructure.com").replace(/\/$/, "");
const LTI_TOOL_PATH = process.env.PORTFLOW_LTI_TOOL_PATH || "/accounts/1/external_tools/23360?launch_type=global_navigation";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const UA = "portflow-mcp/0.2 (+local)";

export class AuthError extends Error {}

const clean = (t) => (t || "").trim().replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "");

export function jwtExpiry(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return p.exp ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

const fresh = (token, marginMs = REFRESH_MARGIN_MS) => {
  const exp = jwtExpiry(token);
  return exp === null ? true : exp - Date.now() > marginMs;
};

function readFileToken(path) {
  try {
    return clean(readFileSync(path, "utf8")) || null;
  } catch {
    return null;
  }
}

export function canvasToken() {
  return clean(process.env.CANVAS_API_TOKEN) || readFileToken(CANVAS_TOKEN_FILE);
}

export function saveToken(token) {
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}

// ── tiny cookie jar + browser-ish navigation ─────────────────────────────────
class Jar {
  constructor() {
    this.byHost = new Map();
  }
  store(url, res) {
    const host = new URL(url).hostname;
    const jar = this.byHost.get(host) || new Map();
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    this.byHost.set(host, jar);
  }
  header(url) {
    const jar = this.byHost.get(new URL(url).hostname);
    return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }
}

const decodeEntities = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/g, "/").replace(/&amp;/g, "&");

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}

// Finds the first <form> (optionally matching actionPart) and returns {action, method, fields}.
function parseForm(html, baseUrl, actionPart) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const form = forms.find((f) => !actionPart || (attr(f.match(/<form\b[^>]*>/i)[0], "action") || "").includes(actionPart));
  if (!form) return null;
  const open = form.match(/<form\b[^>]*>/i)[0];
  const fields = new URLSearchParams();
  for (const [input] of form.matchAll(/<input\b[^>]*>/gi)) {
    const name = attr(input, "name");
    if (name) fields.append(name, attr(input, "value") ?? "");
  }
  return {
    action: new URL(attr(open, "action") || baseUrl, baseUrl).href,
    method: (attr(open, "method") || "GET").toUpperCase(),
    fields,
  };
}

async function go(jar, url, { method = "GET", body, headers = {} } = {}, hops = 0) {
  if (hops > 15) throw new AuthError("Too many redirects during the Canvas → Portflow launch.");
  const h = { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...headers };
  const cookie = jar.header(url);
  if (cookie) h.Cookie = cookie;
  if (body) h["Content-Type"] = "application/x-www-form-urlencoded";
  const res = await fetch(url, { method, headers: h, body, redirect: "manual" });
  jar.store(url, res);
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const next = new URL(res.headers.get("location"), url).href;
    const keep = res.status === 307 || res.status === 308;
    return go(jar, next, keep ? { method, body } : {}, hops + 1);
  }
  return { url, status: res.status, html: await res.text() };
}

// ── the launch ───────────────────────────────────────────────────────────────
let inflight = null;
export let lastLaunchHtml = null;
const PORTFOLIO_ID_FILE = process.env.PORTFLOW_PORTFOLIO_ID_FILE || join(homedir(), ".portflow-portfolio-id");

// The launch page carries the app's props (incl. portfolio.id) in data-react-props.
function portfolioIdFromHtml(html) {
  const m = html && html.match(/data-react-props\s*=\s*"([^"]+)"/);
  if (!m) return null;
  try {
    const id = JSON.parse(decodeEntities(m[1]))?.portfolio?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

// Portfolio id: saved file → last launch page → a fresh Canvas launch (also renews the token).
export async function discoverPortfolioId() {
  try {
    const saved = readFileSync(PORTFOLIO_ID_FILE, "utf8").trim();
    if (/^\d+$/.test(saved)) return saved;
  } catch {}
  let id = portfolioIdFromHtml(lastLaunchHtml);
  if (!id && canvasToken()) {
    await getToken({ forceRefresh: true });
    id = portfolioIdFromHtml(lastLaunchHtml);
  }
  if (id) writeFileSync(PORTFOLIO_ID_FILE, id + "\n", { mode: 0o600 });
  return id;
}

export async function launchForToken(canvasApiToken = canvasToken()) {
  if (!canvasApiToken) throw new AuthError("No Canvas API token configured (CANVAS_API_TOKEN or ~/.canvas-token).");
  const jar = new Jar();

  // 1. Canvas API token → one-time web session URL.
  const st = await fetch(`${CANVAS_BASE}/login/session_token`, {
    headers: { Authorization: `Bearer ${canvasApiToken}`, Accept: "application/json", "User-Agent": UA },
  });
  if (st.status === 401) throw new AuthError("Canvas rejected the Canvas API token (401). Make a new one in Canvas → Account → Settings.");
  if (!st.ok) throw new AuthError(`Canvas /login/session_token failed: ${st.status}`);
  const { session_url } = await st.json();
  if (!session_url) throw new AuthError("Canvas didn't return a session URL.");

  // 2. Visit it to get Canvas session cookies.
  await go(jar, session_url);

  // 3. Canvas tool page → LTI login-initiation form.
  const tool = await go(jar, `${CANVAS_BASE}${LTI_TOOL_PATH}`);
  const login = parseForm(tool.html, tool.url, "drieam");
  if (!login) throw new AuthError("Couldn't find the Portflow launch form on the Canvas page (not logged in to Canvas?).");

  // 4. Login initiation → Canvas OIDC authorize → auto-submitting form with id_token.
  let page = await go(jar, login.action, { method: login.method, body: login.fields.toString() });

  // 5. Follow up to two auto-submit forms (Canvas form_post, any interstitial) until data-session appears.
  for (let i = 0; i < 3; i++) {
    const m = page.html.match(/data-session\s*=\s*"([^"]+)"/);
    if (m) {
      lastLaunchHtml = page.html;
      const token = decodeEntities(m[1]);
      if (!jwtExpiry(token)) throw new AuthError("Portflow returned a session value that isn't a token.");
      return token;
    }
    const form = parseForm(page.html, page.url);
    if (!form || !form.fields.has("id_token") && !form.fields.has("state") && !form.fields.has("lti_message_hint")) break;
    page = await go(jar, form.action, { method: form.method, body: form.fields.toString() });
  }
  throw new AuthError(`Launch finished at ${new URL(page.url).pathname} (HTTP ${page.status}) without a Portflow token.`);
}

// Returns a usable bearer token, refreshing automatically when possible.
export async function getToken({ forceRefresh = false } = {}) {
  const envToken = clean(process.env.PORTFLOW_TOKEN);
  if (envToken) return envToken;

  const saved = readFileToken(TOKEN_FILE);
  if (saved && !forceRefresh && fresh(saved)) return saved;

  if (canvasToken()) {
    inflight ||= launchForToken()
      .then((t) => {
        saveToken(t);
        return t;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  if (saved && fresh(saved, 0) && !forceRefresh) return saved; // still valid, just inside the margin
  return null;
}
