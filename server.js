#!/usr/bin/env node
// Unofficial MCP server for Drieam Portflow (portfolio.drieam.app).
// Auth: Portflow's 8-hour bearer JWT. With a Canvas API token configured
// (`portflow-token canvas`), it is renewed automatically by replaying the Canvas
// LTI launch; otherwise it's read from ~/.portflow-token (see auth.js).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getToken as authGetToken, canvasToken, discoverPortfolioId, AuthError } from "./auth.js";

const BASE = (process.env.PORTFLOW_BASE_URL || "https://portfolio.drieam.app").replace(/\/$/, "");
const MAX_PAGES = 20;

const HOW_TO_REFRESH =
  "Easiest fix (once): run `portflow-token canvas` in Terminal to set up automatic renewal with a Canvas access token. " +
  "Or refresh by hand: open Canvas → Portfolio in Chrome, Cmd+Option+I → Network, filter 'api/v1', right-click a request → " +
  "Copy → Copy as cURL, then run `portflow-token`. Never paste tokens into the chat.";

class PortflowError extends Error {}

async function getToken({ forceRefresh = false } = {}) {
  let t;
  try {
    t = await authGetToken({ forceRefresh });
  } catch (e) {
    if (e instanceof AuthError) throw new PortflowError(`Automatic Portflow login failed: ${e.message} ${HOW_TO_REFRESH}`);
    throw e;
  }
  if (!t) throw new PortflowError(`No valid Portflow token. ${HOW_TO_REFRESH}`);
  return t;
}

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

async function request(pathOrUrl, { method = "GET", body } = {}, retried = false) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}/api/v1${pathOrUrl}`;
  if (!url.startsWith(BASE + "/")) throw new PortflowError(`Refusing to call non-Portflow URL: ${url}`);
  const headers = { Authorization: `Bearer ${await getToken({ forceRefresh: retried })}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !retried && canvasToken()) return request(pathOrUrl, { method, body }, true);
  if (res.status === 401) throw new PortflowError(`Portflow token expired or invalid (401). ${HOW_TO_REFRESH}`);
  if (res.status === 403) throw new PortflowError(`Portflow says you don't have access to ${url} (403).`);
  if (res.status === 404) throw new PortflowError(`Not found: ${url} (404).`);
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {}
    throw new PortflowError(`Portflow request failed: ${method} ${url} → ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { data, next: parseNextLink(res.headers.get("link")) };
}

const send = async (method, path, body) => (await request(path, { method, body })).data;

async function get(path) {
  return (await request(path)).data;
}

// Follows Link rel="next" pages; returns a flat array.
async function getAll(path) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const { data, next: n } = await request(next);
    if (Array.isArray(data)) out.push(...data);
    else if (data && Array.isArray(data.data)) out.push(...data.data);
    else if (data) out.push(data);
    next = n;
  }
  return out;
}

// Portflow rich-text fields are HTML; give Claude a readable version too.
function htmlToText(html) {
  if (typeof html !== "string" || !/[<&]/.test(html)) return html;
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function addPlainText(obj) {
  if (Array.isArray(obj)) return obj.map(addPlainText);
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = addPlainText(v);
    if (typeof v === "string" && /^(description|body|content|text|message|reflection)$/i.test(k) && /<[a-z]/i.test(v)) {
      out[`${k}_text`] = htmlToText(v);
    }
  }
  return out;
}

let cachedPortfolioId = process.env.PORTFLOW_PORTFOLIO_ID || null;

function findPortfolioId(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  for (const key of ["portfolio_id", "current_portfolio_id", "default_portfolio_id"]) {
    if (typeof obj[key] === "number" || typeof obj[key] === "string") return String(obj[key]);
  }
  if (obj.portfolio && obj.portfolio.id) return String(obj.portfolio.id);
  if (Array.isArray(obj.portfolios) && obj.portfolios[0]?.id) return String(obj.portfolios[0].id);
  for (const v of Object.values(obj)) {
    const found = typeof v === "object" ? findPortfolioId(v, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

async function portfolioId() {
  if (cachedPortfolioId) return cachedPortfolioId;
  let id = null;
  try {
    id = await discoverPortfolioId();
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
  }
  if (!id) id = findPortfolioId(await get("/users/current"));
  if (!id) {
    throw new PortflowError(
      "Couldn't work out your portfolio id. Turn on automatic login (`portflow-token canvas`), or set " +
        "PORTFLOW_PORTFOLIO_ID (the number in DevTools requests like /api/v1/portfolios/<id>/...)."
    );
  }
  cachedPortfolioId = id;
  return id;
}

const P = async () => `/portfolios/${await portfolioId()}`;

function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(addPlainText(value), null, 2) }] };
}

function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args ?? {}));
    } catch (err) {
      const msg = err instanceof PortflowError ? err.message : `Unexpected error: ${err?.message || err}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  };
}

// Run several independent requests; a failing one doesn't sink the rest.
async function settle(entries) {
  const results = await Promise.allSettled(entries.map(([, p]) => p));
  const out = {};
  entries.forEach(([key], i) => {
    const r = results[i];
    out[key] = r.status === "fulfilled" ? r.value : { error: r.reason?.message || String(r.reason) };
  });
  return out;
}

const server = new McpServer({ name: "portflow", version: "0.2.0" });
const id = z.union([z.number(), z.string()]).describe("Numeric Portflow id");
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "token_status",
  {
    description:
      "Check the Portflow login: whether automatic renewal (via a Canvas token) is set up, and when the current token expires. " +
      "Renews the token first if it's about to expire and renewal is set up.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  wrap(async () => {
    const autoRenew = Boolean(canvasToken());
    const claims = decodeJwt(await getToken());
    if (!claims?.exp) return { present: true, auto_renew: autoRenew, note: "Token found but it isn't a readable JWT." };
    const minutesLeft = Math.round((claims.exp * 1000 - Date.now()) / 60000);
    return {
      present: true,
      auto_renew: autoRenew,
      expires_at: new Date(claims.exp * 1000).toISOString(),
      minutes_left: minutesLeft,
      ...(autoRenew ? {} : { tip: "Run `portflow-token canvas` once to make renewal automatic." }),
    };
  })
);

server.registerTool(
  "whoami",
  {
    description: "Your Portflow user profile and portfolio id.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  wrap(async () => {
    const me = await get("/users/current");
    let pid = null;
    try {
      pid = await portfolioId();
    } catch {}
    return { portfolio_id: pid, user: me };
  })
);

server.registerTool(
  "list_collections",
  {
    description:
      "List all portfolio collections (e.g. one per project or semester) grouped by section, with evidence and goal counts.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  wrap(async () => {
    const p = await P();
    const [sections, collections] = await Promise.all([getAll(`${p}/sections?page=1`), getAll(`${p}/collections?page=1`)]);
    const bySection = new Map(sections.map((s) => [s.id, { ...s, collections: [] }]));
    const unsectioned = [];
    for (const c of collections) {
      const slim = {
        id: c.id,
        name: c.name,
        subtitle: c.subtitle,
        evidence_count: c.evidence_count,
        goals_count: c.goals_count,
        is_private: c.is_private,
        last_import: c.last_import,
      };
      (bySection.get(c.section_id)?.collections ?? unsectioned).push(slim);
    }
    return { sections: [...bySection.values()], collections_without_section: unsectioned };
  })
);

server.registerTool(
  "get_collection",
  {
    description:
      "Full view of one collection: description, its goals, the evidence under each goal, evidence not in a goal, and collection feedback/comments.",
    inputSchema: { collection_id: id },
    annotations: READ_ONLY,
  },
  wrap(async ({ collection_id }) => {
    const p = await P();
    const c = `${p}/collections/${collection_id}`;
    const base = await settle([
      ["collection", get(c)],
      ["goals", getAll(`${c}/collection-goals?page=1&per_page=50`)],
      ["evidence_not_in_a_goal", getAll(`${c}/evidence?not_in_a_goal=true&page=1`)],
      ["comments", getAll(`${c}/comments?page=1`)],
    ]);
    if (Array.isArray(base.goals)) {
      base.goals = await Promise.all(
        base.goals.map(async (g) => {
          const goalId = g.goal_id ?? g.goal?.id ?? g.id;
          try {
            return { ...g, evidence: await getAll(`${p}/goals/${goalId}/evidence/in-collection/${collection_id}?page=1`) };
          } catch (e) {
            return { ...g, evidence: { error: e.message } };
          }
        })
      );
    }
    return base;
  })
);

server.registerTool(
  "list_evidence",
  {
    description: "List your evidence items across the whole portfolio, newest first.",
    inputSchema: {
      page: z.number().int().min(1).default(1).describe("Page number"),
      per_page: z.number().int().min(1).max(100).default(20).describe("Items per page"),
    },
    annotations: READ_ONLY,
  },
  wrap(async ({ page = 1, per_page = 20 }) => {
    const p = await P();
    const { data, next } = await request(
      `${p}/evidence?order_by=created_at&order_direction=desc&page=${page}&per_page=${per_page}`
    );
    return { page, has_more: Boolean(next), evidence: data };
  })
);

server.registerTool(
  "get_evidence",
  {
    description:
      "Full view of one evidence item: details, latest version (with file ids), version history, linked goals and collections, and feedback/comments.",
    inputSchema: { evidence_id: id },
    annotations: READ_ONLY,
  },
  wrap(async ({ evidence_id }) => {
    const p = await P();
    const e = `${p}/evidence/${evidence_id}`;
    return settle([
      ["evidence", get(e)],
      ["latest_version", get(`${e}/versions/latest`)],
      ["versions", getAll(`${e}/versions?page=1`)],
      ["goals", get(`${e}/goals`)],
      ["sub_goals", get(`${e}/sub-goals`)],
      ["collections", get(`${e}/collections`)],
      ["comments", getAll(`${e}/comments?page=1`)],
    ]);
  })
);

server.registerTool(
  "get_evidence_file_url",
  {
    description:
      "Get a short-lived download/preview URL for a file attached to an evidence version (file id comes from get_evidence → latest_version).",
    inputSchema: { file_id: id },
    annotations: READ_ONLY,
  },
  wrap(async ({ file_id }) => get(`${await P()}/evidence-version-files/${file_id}/preview-url`))
);

server.registerTool(
  "list_goals",
  {
    description: "List your portfolio goals and goal sets (learning outcomes).",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  wrap(async () => {
    const p = await P();
    return settle([
      ["goals", getAll(`${p}/goals?page=1&per_page=50`)],
      ["goal_sets", getAll(`${p}/goal-sets?page=1`)],
    ]);
  })
);

server.registerTool(
  "get_progress_reviews",
  {
    description: "List progress reviews on your portfolio (Goals & Progress tab).",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  wrap(async () => getAll(`${await P()}/progress-review/reviews?page=1&per_page=25`))
);

// ───────────────────────────── Write tools ─────────────────────────────
// Verified against the live app on 2026-11-25 unless marked "not live-tested".
// Nothing here deletes anything.

const MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  html: "text/html", json: "application/json", zip: "application/zip", mp4: "video/mp4", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const MAX_FILE_BYTES = 500 * 1024 * 1024;

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Plain text → Portflow rich text. Text that already looks like HTML is passed through.
function toHtml(text) {
  if (/<\/?(p|br|ul|ol|li|strong|em|h[1-6]|a|blockquote)\b/i.test(text)) return text;
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ActiveStorage direct upload: register blob → PUT bytes to S3 → return signed_id.
async function uploadFile(filePath) {
  const { readFile, stat } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { basename, extname } = await import("node:path");
  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile()) throw new PortflowError(`File not found: ${filePath}`);
  if (st.size > MAX_FILE_BYTES) throw new PortflowError(`${basename(filePath)} is over Portflow's 500 MB limit.`);
  const bytes = await readFile(filePath);
  const filename = basename(filePath);
  const contentType = MIME[extname(filePath).slice(1).toLowerCase()] || "application/octet-stream";
  const blob = await send("POST", "/direct-uploads", {
    blob: { filename, content_type: contentType, byte_size: bytes.length, checksum: createHash("md5").update(bytes).digest("base64") },
  });
  const target = blob?.direct_upload;
  if (!blob?.signed_id || !target?.url) throw new PortflowError("Portflow didn't return an upload URL.");
  const host = new URL(target.url).hostname;
  if (!host.endsWith(".amazonaws.com")) throw new PortflowError(`Unexpected upload host ${host}; refusing to upload.`);
  const put = await fetch(target.url, { method: "PUT", headers: target.headers || {}, body: bytes });
  if (!put.ok) throw new PortflowError(`Uploading ${filename} to storage failed: ${put.status} ${put.statusText}`);
  return { signed_id: blob.signed_id, file_name: filename, type: contentType };
}

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const OVERWRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const ids = z.array(z.union([z.number(), z.string()])).default([]);

server.registerTool(
  "create_evidence",
  {
    description:
      "Upload one or more local files to Portflow as a NEW piece of evidence (like 'Add evidence → File upload'). " +
      "Optionally link it to collections (ids from list_collections) and goals (goal ids from list_goals / get_collection → goals[].goal.id), " +
      "and set a description/reflection. Always confirm the name, files, collections and goals with the user before calling.",
    inputSchema: {
      name: z.string().min(1).max(200).describe("Evidence name shown in Portflow"),
      file_paths: z.array(z.string()).min(1).max(50).describe("Absolute paths of local files to upload"),
      description: z.string().optional().describe("Optional description/reflection (plain text or HTML)"),
      collection_ids: ids.describe("Collections to add it to"),
      goal_ids: ids.describe("Goals to link it to"),
    },
    annotations: WRITE,
  },
  wrap(async ({ name, file_paths, description, collection_ids = [], goal_ids = [] }) => {
    const files = [];
    for (const p of file_paths) files.push(await uploadFile(p));
    const evidence = await send("POST", `${await P()}/evidence`, {
      files,
      collection_ids: collection_ids.map(Number),
      goal_ids: goal_ids.map(Number),
      activity_ids: [],
      version_type: "file",
      name,
    });
    if (description && evidence?.id) await send("PUT", `${await P()}/evidence/${evidence.id}`, { description: toHtml(description) });
    return {
      created: true,
      evidence_id: evidence?.id,
      name: evidence?.name,
      files: files.map((f) => f.file_name),
      collections_count: evidence?.collections_count,
      goals_count: evidence?.goals_count,
      url: evidence?.id ? `${BASE}/portfolio/evidence/${evidence.id}/versions/latest` : null,
    };
  })
);

server.registerTool(
  "add_evidence_version",
  {
    description:
      "Upload a NEW VERSION of an existing evidence item (like the 'Add new version' button). Old versions stay in the history. " +
      "By default the new version contains only the new files; set keep_existing_files to carry over files from the latest version " +
      "(all of them, or only the names you list). Optionally add a version note describing what changed. " +
      "Confirm the evidence, files and note with the user before calling.",
    inputSchema: {
      evidence_id: id,
      file_paths: z.array(z.string()).max(50).default([]).describe("Absolute paths of new local files for this version"),
      keep_existing_files: z
        .union([z.boolean(), z.array(z.string())])
        .default(false)
        .describe("false = only new files; true = also keep all files of the latest version; or a list of file names to keep"),
      version_note: z.string().optional().describe("What changed in this version (plain text or HTML)"),
    },
    annotations: WRITE,
  },
  wrap(async ({ evidence_id, file_paths = [], keep_existing_files = false, version_note }) => {
    const p = await P();
    const kept = [];
    if (keep_existing_files) {
      const latest = await get(`${p}/evidence/${evidence_id}/versions/latest`);
      const current = (latest?.files || []).filter((f) => f?.file?.signed_id);
      const wanted = Array.isArray(keep_existing_files) ? keep_existing_files.map((n) => n.toLowerCase()) : null;
      for (const f of current) {
        const name = f.file.file_name || "";
        if (!wanted || wanted.includes(name.toLowerCase())) kept.push(f);
      }
      if (wanted && kept.length !== wanted.length) {
        const have = current.map((f) => f.file.file_name).join(", ") || "none";
        throw new PortflowError(`Couldn't find all files to keep. Files in the latest version: ${have}`);
      }
    }
    if (!file_paths.length && !kept.length) throw new PortflowError("A new version needs at least one new or kept file.");
    const uploaded = [];
    for (const path of file_paths) uploaded.push(await uploadFile(path));
    const body = {
      files: [...uploaded, ...kept.map((f) => ({ signed_id: f.file.signed_id, file_name: f.file.file_name }))],
      existing_files: kept.map((f) => String(f.id)),
      version_type: "file",
    };
    if (version_note) body.description = toHtml(version_note);
    const version = await send("POST", `${p}/evidence/${evidence_id}/versions`, body);
    return {
      created: true,
      evidence_id,
      version_number: version?.version_number,
      version_id: version?.id,
      files: (version?.files || []).map((f) => f?.file?.file_name).filter(Boolean),
      url: `${BASE}/portfolio/evidence/${evidence_id}/versions/latest`,
    };
  })
);

server.registerTool(
  "update_evidence_description",
  {
    description:
      "Replace the description/reflection text of an existing evidence item. This OVERWRITES the current description, " +
      "so read it first with get_evidence and confirm the new text with the user.",
    inputSchema: {
      evidence_id: id,
      description: z.string().describe("New description (plain text or HTML)"),
    },
    annotations: OVERWRITE,
  },
  wrap(async ({ evidence_id, description }) => {
    await send("PUT", `${await P()}/evidence/${evidence_id}`, { description: toHtml(description) });
    return { updated: true, evidence_id };
  })
);

server.registerTool(
  "add_evidence_comment",
  {
    description:
      "Post a comment in the 'Evidence feedback' thread of an evidence item (on its latest version), as you (role: student). " +
      "People the evidence is shared with can see it. Confirm the text with the user first.",
    inputSchema: {
      evidence_id: id,
      text: z.string().min(1).describe("Comment text (plain text or HTML)"),
    },
    annotations: WRITE,
  },
  wrap(async ({ evidence_id, text }) => {
    const latest = await get(`${await P()}/evidence/${evidence_id}/versions/latest`);
    const versionId = latest?.id;
    if (!versionId) throw new PortflowError("Couldn't find the latest version of that evidence.");
    await send("POST", `${await P()}/evidence-versions/${versionId}/comments`, {
      text: toHtml(text),
      created_by_role: "student",
      attachments: [],
    });
    return { posted: true, evidence_id, evidence_version_id: versionId };
  })
);

server.registerTool(
  "add_collection_comment",
  {
    description:
      "Post a comment in a collection's 'Collection feedback' thread, as you (role: student). Teachers/coaches the collection " +
      "is shared with will see it and may be notified. Not live-tested yet. Confirm the text with the user first.",
    inputSchema: {
      collection_id: id,
      text: z.string().min(1).describe("Comment text (plain text or HTML)"),
    },
    annotations: WRITE,
  },
  wrap(async ({ collection_id, text }) => {
    await send("POST", `${await P()}/collections/${collection_id}/comments`, {
      text: toHtml(text),
      created_by_role: "student",
      attachments: [],
    });
    return { posted: true, collection_id };
  })
);

server.registerTool(
  "update_collection_description",
  {
    description:
      "Replace a collection's description (the 'Collection description' text, e.g. your process write-up). This OVERWRITES " +
      "the current text, so read it first with get_collection and confirm the full new text with the user. Not live-tested yet.",
    inputSchema: {
      collection_id: id,
      description: z.string().describe("New description (plain text or HTML)"),
    },
    annotations: OVERWRITE,
  },
  wrap(async ({ collection_id, description }) => {
    await send("PUT", `${await P()}/collections/${collection_id}`, { description: toHtml(description) });
    return { updated: true, collection_id };
  })
);

await server.connect(new StdioServerTransport());
