# portflow-mcp

Unofficial MCP server that lets Claude read and add to your Drieam Portflow
portfolio (Fontys ICT): collections, evidence, goals, feedback and progress reviews,
plus uploading evidence, writing descriptions and posting comments.

> **Disclaimer:** not affiliated with, endorsed by or supported by Drieam or Fontys. Use it only on your
> own portfolio, at your own risk, and in line with your school's acceptable-use rules.

It uses Portflow's internal API (see
[API.md](API.md)), which can change without notice.

## Tools

| Tool | What it returns |
|---|---|
| `token_status` | whether your token is set and how many minutes it has left |
| `whoami` | your profile + portfolio id |
| `list_collections` | all collections grouped by section |
| `get_collection(collection_id)` | description, goals, evidence per goal, feedback |
| `list_evidence(page, per_page)` | all evidence, newest first |
| `get_evidence(evidence_id)` | details, latest version, history, goals, feedback |
| `get_evidence_file_url(file_id)` | short-lived link to an attached file |
| `list_goals` | goals and goal sets |
| `get_progress_reviews` | progress reviews |

### Write tools

| Tool | What it does | Tested live |
|---|---|---|
| `create_evidence(name, file_paths, description?, collection_ids?, goal_ids?)` | uploads local files as a new evidence item, optionally into collections/goals | ✅ (upload + create) |
| `add_evidence_version(evidence_id, file_paths, keep_existing_files?, version_note?)` | uploads a new version (V2, V3…) like the "Add new version" button; old versions stay; can carry over files from the latest version | ✅ |
| `update_evidence_description(evidence_id, description)` | **replaces** an evidence item's description/reflection | ✅ |
| `add_evidence_comment(evidence_id, text)` | posts in an evidence item's feedback thread | ✅ |
| `add_collection_comment(collection_id, text)` | posts in a collection's feedback thread (teachers may get notified) | ⚠️ not yet |
| `update_collection_description(collection_id, description)` | **replaces** a collection's description | ⚠️ not yet |

- Text can be plain (paragraphs become `<p>`) or HTML.
- Every write tool is marked as non-read-only, so Claude asks before each call.
- Nothing deletes anything. Deleting and moving to the trash bin stay manual.
- Linking to goals at creation is sent as Portflow goal ids; this exact path hasn't been
  checked live yet. If a goal link doesn't show up, link it in Portflow by hand.

## Setup

1. Install dependencies and the `portflow-token` command (once):

   ```bash
   npm install && npm link
   ```

2. Register with Claude Code (use the folder's real absolute path):

   ```bash
   claude mcp add portflow --scope user -- node /ABSOLUTE/PATH/portflow-mcp/server.js
   ```

3. Turn on automatic login (recommended, see below), or save a token by hand.

## Automatic login (recommended, one-time setup)

Portflow tokens last 8 hours and there's no refresh endpoint. With a Canvas access
token, the MCP replays the same Canvas → Portflow launch your browser does and gets
a new Portflow token by itself whenever the old one is about to expire (or on a 401).

1. Canvas → **Account** → **Settings** → **+ New access token**
   (purpose "Portflow MCP", expiry e.g. end of semester) → **Generate token** → copy it.
2. In Terminal:

   ```bash
   portflow-token canvas
   ```

   It reads the token from the clipboard, checks it with Canvas, saves it to
   `~/.canvas-token` (mode 600), clears the clipboard, and tests a Portflow login.

That's it. `portflow-token refresh` forces a new Portflow token;
`portflow-token status` shows whether automatic renewal is on.

When the Canvas token expires (on the date you picked), make a new one and repeat
step 2. To switch automatic login off, delete it in Canvas and run `rm ~/.canvas-token`.

## Manual mode: copying the Portflow token (every ~8 hours)

Without a Canvas token, copy the Portflow token from Chrome:

1. Open Canvas → **Portfolio** in Chrome.
2. `Cmd+Option+I` → **Network** tab → type `api/v1` in the filter.
3. Click anything in Portflow, then **right-click** any `api/v1/...` request →
   **Copy** → **Copy as cURL**.
4. In Terminal:

   ```bash
   portflow-token
   ```

It pulls the token out of your clipboard, checks it with Portflow, saves it to
`~/.portflow-token` (mode 600), clears the clipboard, and tells you when it
expires. It also accepts a bare token, `Bearer …`, or `authorization: Bearer …`.

| Command | What it does |
|---|---|
| `portflow-token` | save the token from the clipboard (recommended) |
| `portflow-token <token>` | save a token typed after the command (stays in shell history) |
| `portflow-token status` | does the saved token still work, and how long it has left |
| `portflow-token clear` | delete the saved token |

The MCP server re-reads the file on every call, so there's no restart needed.
You can also ask Claude "check my portflow token".

## Security notes

- The Portflow token gives full access to your Portflow account for its lifetime. Keep it
  in `~/.portflow-token` (mode 600), never commit it, never paste it in chat.
- The **Canvas access token is more powerful**: it acts as you in all of Canvas until it
  expires. Give it an expiry date, keep it only in `~/.canvas-token`, and delete it in
  Canvas → Settings if your laptop is lost. The MCP uses it only to open a Canvas web
  session and launch Portflow; it never calls other Canvas APIs.
- The server only calls `https://portfolio.drieam.app` (override with
  `PORTFLOW_BASE_URL`) and refuses any other host.

## Config

| Env var | Default | Purpose |
|---|---|---|
| `PORTFLOW_TOKEN` | – | token directly (overrides the file) |
| `PORTFLOW_TOKEN_FILE` | `~/.portflow-token` | where to read the token |
| `PORTFLOW_PORTFOLIO_ID` | auto-detected on first login (saved in `~/.portflow-portfolio-id`) | your portfolio id |
| `PORTFLOW_BASE_URL` | `https://portfolio.drieam.app` | API host |
| `CANVAS_BASE_URL` | `https://fontysict.instructure.com` | your Canvas site |
| `PORTFLOW_LTI_TOOL_PATH` | `/accounts/1/external_tools/23360?launch_type=global_navigation` | Canvas link that opens Portflow (hover the "Portfolio" menu item in Canvas to find yours) |
| `CANVAS_API_TOKEN` / `CANVAS_TOKEN_FILE` | – / `~/.canvas-token` | Canvas access token for automatic login |

## Other schools

Defaults are set for Fontys ICT. For another Canvas + Portflow school, set
`CANVAS_BASE_URL` and `PORTFLOW_LTI_TOOL_PATH` (in the `claude mcp add … -e` command
and in your shell for `portflow-token`).

## License

MIT
