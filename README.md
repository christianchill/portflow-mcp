# portflow-mcp

Unofficial MCP server that lets Claude read and add to your Drieam Portflow
portfolio (Fontys ICT): collections, evidence, goals, feedback and progress reviews,
plus uploading evidence and new versions, writing descriptions and posting comments.

> **Disclaimer:** not affiliated with, endorsed by or supported by Drieam or Fontys. Use it only on your
> own portfolio, at your own risk, and in line with your school's acceptable-use rules.
> It uses Portflow's internal API (see [API.md](API.md)), which can change without notice.

Once it's set up you can ask Claude things like:

- *"What's in my Challenge 3 collection, and which evidence has no feedback yet?"*
- *"Upload ~/Documents/Ontwerpdocument_v2.pdf as a new version of my Ontwerpdocument evidence."*
- *"Write a reflection for my research document and put it in the evidence description."*

---

## Setup guide

About 10 minutes, once. Tested on macOS.

### What you need

- **Node.js 18 or newer**: check with `node --version`. Install from [nodejs.org](https://nodejs.org) or `brew install node`.
- **Claude Code** and/or the **Claude desktop app**.
- A **Canvas account** where Portflow opens from the Canvas menu (Fontys ICT by default; for other schools see [Other schools](#other-schools)).

### Step 1: Download and install

```bash
git clone https://github.com/christianchill/portflow-mcp.git
cd portflow-mcp
npm install
npm link
```

`npm link` adds the `portflow-token` command to your terminal. Check it with:

```bash
portflow-token --help
```

Note the full path of the folder, you need it in step 3:

```bash
pwd
```

### Step 2: Turn on automatic login

Portflow only lets you in through Canvas, and its login lasts 8 hours. With a Canvas
access token, the server logs in through Canvas by itself whenever it needs to, so you
never have to copy Portflow tokens by hand.

1. In Canvas go to **Account** → **Settings**.
2. Under **Approved integrations** click **+ New access token**.
   - Purpose: `Portflow MCP`
   - Expires: pick a date, e.g. the end of the semester
3. Click **Generate token** and **copy** it. Canvas shows it only once.
4. Run:

   ```bash
   portflow-token canvas
   ```

   It reads the token from your clipboard, checks it, saves it privately in
   `~/.canvas-token`, clears your clipboard and tests a Portflow login. You should see:

   ```
   ✓ Canvas token saved for <your name> …
   ✓ signed in as <your name>. Portflow token valid until … (8h 0m left).
   ```

> Don't paste the Canvas token into a chat with Claude. The command's output is safe to share.

No Canvas token, or not allowed to make one? See [Manual login](#manual-login-without-a-canvas-token).

### Step 3: Connect it to Claude

Replace `/FULL/PATH/portflow-mcp` with the path from `pwd` in step 1.

**Claude Code** (terminal, VS Code/JetBrains, or the desktop app's Code tab):

```bash
claude mcp add portflow --scope user -- node /FULL/PATH/portflow-mcp/server.js
```

`--scope user` makes it available in every project.

**Claude desktop app, Chat tab:**

1. Find the full path of `node`:

   ```bash
   which node
   ```

2. Open the config file (Claude → **Settings** → **Developer** → **Edit Config**), or:

   ```bash
   open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

3. Add `portflow` inside `"mcpServers"`, using the paths from above. Keep any servers already listed:

   ```json
   {
     "mcpServers": {
       "portflow": {
         "command": "/opt/homebrew/bin/node",
         "args": ["/FULL/PATH/portflow-mcp/server.js"]
       }
     }
   }
   ```

   Use the full `node` path: the desktop app doesn't see your terminal's `PATH`.

4. Quit Claude completely (`Cmd+Q`) and open it again.

### Step 4: Check it works

1. Start a **new** chat or Claude Code session. Already-open ones don't see new servers.
2. Ask: *"Check my Portflow token"*, then *"List my Portflow collections"*.
3. Allow the `portflow` tools when Claude asks.

In Claude Code you can also run `claude mcp get portflow`. It should say **✔ Connected**.

That's it. 🎉

---

## Everyday use

- **Nothing to do day-to-day.** The server renews the Portflow login by itself.
- **Write actions ask first.** Claude asks your permission before every upload, edit or comment.
- **When your Canvas token expires** (the date you picked): make a new one (step 2) and run `portflow-token canvas` again.
- **Updating to a newer version:**

  ```bash
  cd /FULL/PATH/portflow-mcp && git pull && npm install
  ```

  Then start a new chat, or restart the desktop app.

### `portflow-token` commands

| Command | What it does |
|---|---|
| `portflow-token canvas` | one-time setup: save a Canvas token for automatic login |
| `portflow-token status` | is automatic login on, and how long the current Portflow login lasts |
| `portflow-token refresh` | get a fresh Portflow login now |
| `portflow-token` | manual mode: save a Portflow token from your clipboard |
| `portflow-token clear` | delete the saved Portflow token |

## Troubleshooting

| Problem | Fix |
|---|---|
| `portflow-token: command not found` | Run `npm link` again in the project folder. |
| Claude doesn't show any Portflow tools | Start a new chat/session. For the Chat tab: check the JSON is valid and uses full paths, then `Cmd+Q` and reopen. |
| "Canvas rejected the Canvas API token (401)" | The Canvas token expired or was deleted. Make a new one and run `portflow-token canvas`. |
| "Automatic Portflow login failed …" | Run `portflow-token refresh` to see which step fails. Other schools: check [Other schools](#other-schools). |
| "Couldn't work out your portfolio id" | Turn on automatic login (step 2), or set `PORTFLOW_PORTFOLIO_ID` (see [Config](#config)). |
| Errors after Portflow had an update | Portflow's internal API may have changed. Open an issue on GitHub. |

To remove it: `claude mcp remove portflow -s user`, delete the `portflow` block from the desktop config,
delete the token in Canvas → Settings, and run `rm ~/.canvas-token ~/.portflow-token ~/.portflow-portfolio-id`.

---

## Tools

### Read

| Tool | What it returns |
|---|---|
| `token_status` | whether automatic login is on and how long the current login lasts |
| `whoami` | your profile + portfolio id |
| `list_collections` | all collections grouped by section |
| `get_collection(collection_id)` | description, goals, evidence per goal, feedback |
| `list_evidence(page, per_page)` | all evidence, newest first |
| `get_evidence(evidence_id)` | details, latest version, history, goals, feedback |
| `get_evidence_file_url(file_id)` | short-lived link to an attached file |
| `list_goals` | goals and goal sets |
| `get_progress_reviews` | progress reviews |

### Write

| Tool | What it does | Tested live |
|---|---|---|
| `create_evidence(name, file_paths, description?, collection_ids?, goal_ids?)` | uploads local files as a new evidence item, optionally into collections/goals | ✅ |
| `add_evidence_version(evidence_id, file_paths, keep_existing_files?, version_note?)` | uploads a new version (V2, V3…) like the "Add new version" button; old versions stay | ✅ |
| `update_evidence_description(evidence_id, description)` | **replaces** an evidence item's description/reflection | ✅ |
| `add_evidence_comment(evidence_id, text)` | posts in an evidence item's feedback thread | ✅ |
| `add_collection_comment(collection_id, text)` | posts in a collection's feedback thread (teachers may get notified) | ⚠️ not yet |
| `update_collection_description(collection_id, description)` | **replaces** a collection's description | ⚠️ not yet |

- Text can be plain (paragraphs become `<p>`) or HTML.
- Nothing deletes anything. Deleting and moving to the trash bin stay manual in Portflow.
- Linking to goals when creating evidence hasn't been checked live yet. If a goal link doesn't show up, link it in Portflow by hand.

## Manual login (without a Canvas token)

You can also copy the Portflow login from your browser. You have to repeat this about every 8 hours.

1. In Chrome open Canvas → **Portfolio**.
2. `Cmd+Option+I` → **Network** tab → type `api/v1` in the filter.
3. Click anything in Portflow, then **right-click** any `api/v1/...` request → **Copy** → **Copy as cURL**.
4. Run:

   ```bash
   portflow-token
   ```

It finds the token in what you copied, checks it, saves it in `~/.portflow-token` and clears
your clipboard. There's no restart needed; the server reads the file on every call.

## Security notes

- The **Portflow token** gives access to your Portflow account for 8 hours. It's stored in
  `~/.portflow-token` (only you can read it). Never commit it or paste it into a chat.
- The **Canvas access token is more powerful**: it acts as you in all of Canvas until it
  expires. Give it an expiry date, keep it only in `~/.canvas-token`, and delete it in
  Canvas → Settings if your laptop is lost. The server uses it only to open a Canvas web
  session and launch Portflow; it never calls other Canvas APIs.
- The server only talks to Portflow (`https://portfolio.drieam.app`), Portflow's file
  storage, and your Canvas site (to log in). It refuses any other host for API calls and uploads.

## Config

All optional. Set them with `-e NAME=value` in `claude mcp add`, in an `"env": {}` block
in the desktop config, or in your shell for `portflow-token`.

| Env var | Default | Purpose |
|---|---|---|
| `CANVAS_BASE_URL` | `https://fontysict.instructure.com` | your Canvas site |
| `PORTFLOW_LTI_TOOL_PATH` | `/accounts/1/external_tools/23360?launch_type=global_navigation` | Canvas link that opens Portflow |
| `CANVAS_API_TOKEN` / `CANVAS_TOKEN_FILE` | – / `~/.canvas-token` | Canvas access token for automatic login |
| `PORTFLOW_PORTFOLIO_ID` | auto-detected on first login (saved in `~/.portflow-portfolio-id`) | your portfolio id |
| `PORTFLOW_TOKEN` | – | a fixed Portflow token (turns off auto-renewal) |
| `PORTFLOW_TOKEN_FILE` | `~/.portflow-token` | where the Portflow token is stored |
| `PORTFLOW_BASE_URL` | `https://portfolio.drieam.app` | Portflow host |

## Other schools

The defaults are for Fontys ICT. For another school that uses Canvas + Portflow:

1. `CANVAS_BASE_URL`: your Canvas address, e.g. `https://yourschool.instructure.com`.
2. `PORTFLOW_LTI_TOOL_PATH`: in Canvas, right-click the **Portfolio** menu item → **Copy link**,
   and use the part after the domain (starting with `/accounts/…`).

Set both when you register the server, and in your shell when running `portflow-token`:

```bash
claude mcp add portflow --scope user \
  -e CANVAS_BASE_URL=https://yourschool.instructure.com \
  -e "PORTFLOW_LTI_TOOL_PATH=/accounts/1/external_tools/12345?launch_type=global_navigation" \
  -- node /FULL/PATH/portflow-mcp/server.js
```

## License

MIT, see [LICENSE](LICENSE).
