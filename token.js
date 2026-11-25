#!/usr/bin/env node
// portflow-token: save / check the Portflow token used by the portflow MCP server.
//
//   portflow-token canvas     ONE-TIME: save a Canvas access token so Portflow logins renew automatically
//   portflow-token refresh    get a fresh Portflow token now via Canvas
//   portflow-token            save a Portflow token from your clipboard (manual mode)
//   portflow-token status     show whether the saved token works and when it expires
//   portflow-token clear      delete the saved Portflow token
//
// The clipboard can hold any of:
//   - the bare token (eyJ...)
//   - "Bearer eyJ..." or "authorization: Bearer eyJ..."
//   - a whole request from DevTools → right-click → Copy → Copy as cURL

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchForToken, saveToken as saveAuthToken, canvasToken } from "./auth.js";

const CANVAS_BASE = (process.env.CANVAS_BASE_URL || "https://fontysict.instructure.com").replace(/\/$/, "");
const CANVAS_TOKEN_FILE = process.env.CANVAS_TOKEN_FILE || join(homedir(), ".canvas-token");
const BASE = (process.env.PORTFLOW_BASE_URL || "https://portfolio.drieam.app").replace(/\/$/, "");
const TOKEN_FILE = process.env.PORTFLOW_TOKEN_FILE || join(homedir(), ".portflow-token");

const c = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, y: (s) => s, b: (s) => s };

const HELP = `
${c.b("How to copy the token")}
  1. In Chrome open Canvas → Portfolio.
  2. Cmd+Option+I → Network tab → type ${c.b("api/v1")} in the filter.
  3. Click anything in Portflow, then right-click any api/v1 request
     → Copy → ${c.b("Copy as cURL")}.
  4. Run ${c.b("portflow-token")} again.
`;

function readClipboard() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    return "";
  }
}

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

function extractToken(text) {
  if (!text) return null;
  // Prefer a token that sits right after "Bearer" (cURL / header copies).
  const bearer = text.match(/bearer\s+(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i);
  if (bearer) return bearer[1];
  const bare = text.match(JWT_RE);
  return bare ? bare[0] : null;
}

function claims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function describeExpiry(token) {
  const p = claims(token);
  if (!p?.exp) return { expired: false, text: "unknown expiry" };
  const mins = Math.round((p.exp * 1000 - Date.now()) / 60000);
  const at = new Date(p.exp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (mins <= 0) return { expired: true, text: `expired at ${at}` };
  const h = Math.floor(mins / 60);
  return { expired: false, text: `valid until ${at} (${h ? `${h}h ` : ""}${mins % 60}m left)` };
}

async function check(token) {
  try {
    const res = await fetch(`${BASE}/api/v1/users/current`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 401) return { ok: false, msg: "Portflow rejected it (401: expired or not a Portflow token)" };
    if (!res.ok) return { ok: false, msg: `Portflow answered ${res.status}` };
    const me = await res.json();
    const name = me?.name || me?.full_name || me?.display_name || [me?.first_name, me?.last_name].filter(Boolean).join(" ");
    return { ok: true, msg: name ? `signed in as ${name}` : "accepted by Portflow" };
  } catch (e) {
    return { ok: null, msg: `couldn't reach Portflow (${e.message}); saved anyway` };
  }
}

function readSaved() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function save(source) {
  const token = extractToken(source);
  if (!token) {
    console.log(c.r("✗ No Portflow token found in what you gave me (or in your clipboard)."));
    console.log(HELP);
    process.exit(1);
  }
  const exp = describeExpiry(token);
  if (exp.expired) {
    console.log(c.r(`✗ That token already ${exp.text}. Copy a fresh one.`));
    console.log(HELP);
    process.exit(1);
  }
  const result = await check(token);
  if (result.ok === false) {
    console.log(c.r(`✗ Not saved: ${result.msg}.`));
    console.log(HELP);
    process.exit(1);
  }
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  // Overwrite the clipboard so the token doesn't linger there.
  try {
    execFileSync("pbcopy", { input: "" });
  } catch {}
  console.log(c.g(`✓ Token saved, ${result.msg}. ${exp.text}.`));
  console.log("  Clipboard cleared. Claude can use Portflow now, no restart needed.");
}

async function status() {
  const auto = Boolean(canvasToken());
  console.log(auto ? c.g("Automatic renewal: on (Canvas token saved)") : c.y("Automatic renewal: off (run `portflow-token canvas` to turn it on)"));
  const token = readSaved();
  if (!token) {
    console.log(c.y(auto ? "No Portflow token yet; the MCP will fetch one on first use." : "No token saved yet."));
    if (!auto) console.log(HELP);
    process.exit(auto ? 0 : 1);
  }
  const exp = describeExpiry(token);
  if (exp.expired) {
    console.log(auto ? c.y(`Saved Portflow token ${exp.text}; the MCP renews it on next use.`) : c.r(`✗ Saved token ${exp.text}.`));
    if (!auto) console.log(HELP);
    process.exit(auto ? 0 : 1);
  }
  const result = await check(token);
  const mark = result.ok ? c.g("✓") : result.ok === false ? c.r("✗") : c.y("?");
  console.log(result.ok === false ? `${mark} ${result.msg}.` : `${mark} ${result.msg}; ${exp.text}.`);
  if (result.ok === false) console.log(HELP);
  process.exit(result.ok === false ? 1 : 0);
}

const CANVAS_HELP = `
${c.b("Make a Canvas access token (one time)")}
  1. Canvas → ${c.b("Account")} → ${c.b("Settings")}.
  2. Under "Approved integrations" click ${c.b("+ New access token")}.
     Purpose: "Portflow MCP". Pick an expiry date (e.g. end of the semester).
  3. Click ${c.b("Generate token")} and copy it (Canvas shows it only once).
  4. Run ${c.b("portflow-token canvas")} again.
`;

async function refreshViaCanvas(label = "Fetching a fresh Portflow token via Canvas…") {
  console.log(label);
  const token = await launchForToken();
  saveAuthToken(token);
  const result = await check(token);
  if (result.ok === false) throw new Error(`Portflow didn't accept the new token: ${result.msg}`);
  console.log(c.g(`✓ ${result.msg.replace(/\.$/, "")}. Portflow token ${describeExpiry(token).text}.`));
}

async function setupCanvas(source) {
  const m = (source || "").match(/\b\d{2,6}~[A-Za-z0-9]{30,}\b/);
  if (!m) {
    console.log(c.r("✗ No Canvas access token found (they look like 1234~AbC…)."));
    console.log(CANVAS_HELP);
    process.exit(1);
  }
  const tok = m[0];
  const res = await fetch(`${CANVAS_BASE}/api/v1/users/self`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    console.log(c.r(`✗ Canvas rejected that token (${res.status}). Make a new one.`));
    console.log(CANVAS_HELP);
    process.exit(1);
  }
  const me = await res.json();
  writeFileSync(CANVAS_TOKEN_FILE, tok + "\n", { mode: 0o600 });
  chmodSync(CANVAS_TOKEN_FILE, 0o600);
  try {
    execFileSync("pbcopy", { input: "" });
  } catch {}
  console.log(c.g(`✓ Canvas token saved for ${me.name || "you"} (${CANVAS_TOKEN_FILE}, only you can read it). Clipboard cleared.`));
  try {
    await refreshViaCanvas("Testing an automatic Portflow login…");
    console.log("  From now on the MCP renews the Portflow token by itself. Nothing else to do.");
  } catch (e) {
    console.log(c.r(`✗ Canvas token works, but the automatic Portflow login failed: ${e.message}`));
    console.log("  Manual mode (portflow-token with a copied cURL) still works.");
    process.exit(1);
  }
}

const cmd = process.argv[2];
if (cmd === "canvas") {
  const fromArgs = process.argv.slice(3).join(" ");
  const piped = !fromArgs && !process.stdin.isTTY ? readFileSync(0, "utf8") : "";
  if (fromArgs) console.log(c.y("Note: a token typed as an argument stays in your shell history.\n"));
  await setupCanvas(fromArgs || piped || readClipboard());
} else if (cmd === "refresh") {
  if (!canvasToken()) {
    console.log(c.y("Automatic renewal isn't set up yet. Run: portflow-token canvas"));
    console.log(CANVAS_HELP);
    process.exit(1);
  }
  try {
    await refreshViaCanvas();
  } catch (e) {
    console.log(c.r(`✗ ${e.message}`));
    process.exit(1);
  }
} else if (cmd === "status") await status();
else if (cmd === "clear") {
  try {
    unlinkSync(TOKEN_FILE);
    console.log(c.g("✓ Token deleted."));
  } catch {
    console.log("No token was saved.");
  }
} else if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(`portflow-token canvas     one-time setup: automatic renewal via a Canvas access token
portflow-token refresh    get a fresh Portflow token now (needs the setup above)
portflow-token            save a Portflow token from your clipboard (manual mode)
portflow-token <token>    save a token you paste after the command
portflow-token status     check the saved token
portflow-token clear      delete the saved token
${HELP}`);
} else if (!cmd) {
  // Piped input (e.g. `pbpaste | portflow-token`) wins over the clipboard.
  const piped = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  await save(piped || readClipboard());
} else if (extractToken(process.argv.slice(2).join(" "))) {
  // Token passed as argument(s): `portflow-token eyJ...` or `portflow-token Bearer eyJ...`
  console.log(c.y("Note: a token typed as an argument stays in your shell history."));
  console.log(c.y("Next time just copy it and run `portflow-token` with nothing after it.\n"));
  await save(process.argv.slice(2).join(" "));
} else {
  console.log(`Unknown command "${cmd}". Try: portflow-token --help`);
  process.exit(1);
}
