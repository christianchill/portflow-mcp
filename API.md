# Portflow API map (Fontys ICT)

Mapped November 2026 by watching the Portflow web app's own requests (Fontys ICT tenant). Unofficial and
undocumented: Drieam can change it at any time.

## Host and launch

- App + API host: `https://portfolio.drieam.app`
- Canvas opens Portflow through LTI 1.3: Canvas page
  `https://fontysict.instructure.com/accounts/1/external_tools/23360?launch_type=global_navigation`
  renders a form that POSTs to `https://portfolio.drieam.app/lti/open_id`
  (fields: iss, login_hint, client_id, lti_deployment_id, target_link_uri,
  lti_message_hint, canvas_environment, canvas_region, lti_storage_target).
- The form's `lti_message_hint` is single-use. Submitting a *fresh* copy of that
  form top-level (instead of in Canvas's iframe) opens Portflow in a normal tab.
- Standalone sign-in (`/sso`) does **not** work for Fontys accounts
  ("couldn't find an institution"). LTI from Canvas is the only way in.

## Authentication

Every API request sends:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <JWT>` (~760 chars) |
| `X-CSRF-Token` | from `<meta name="csrf-token">` on the Portflow page |
| `Content-Type` | `application/json` |

- JWT claims: `iat`, `exp`, `nonce`, `session`, `sub`. **Lifetime: 8 hours.**
- The token lives only in the page's JS memory: no usable cookie, no
  localStorage/sessionStorage. A full page reload → API returns 401.
- So an MCP needs a token you copy from DevTools (Network → any `/api/v1/` request
  → Request Headers → `authorization`) at most once every 8 hours, or a launch
  automation (see "Getting a token automatically" below).

## Pagination

`?page=N` (and often `&per_page=N`). Next/prev pages come in a `Link` response header.

## IDs

`{pid}` is your portfolio id (run the `whoami` tool, or look at any `/api/v1/portfolios/<pid>/…`
request in DevTools). Collection, goal and evidence ids come from the list endpoints below.

## Endpoints (all prefixed `https://portfolio.drieam.app/api/v1`)

### User / app
| Method | Path | Notes |
|---|---|---|
| GET | `/users/current` | your profile (find portfolio id here) |
| GET | `/users/current/preferences` | |
| GET | `/notification/notifications/unread-count` | |
| GET | `/capabilities` | feature flags |
| GET | `/status-message` | |

### Portfolio
| Method | Path | Notes |
|---|---|---|
| GET | `/portfolios/{pid}` | portfolio itself |
| GET | `/portfolios/{pid}/sections?page=1&per_page=5` | collection groups, e.g. "Startsemester - Fall 2026" |
| GET | `/portfolios/{pid}/sections/{sid}` | |
| GET | `/portfolios/{pid}/shares?page=1` | who it's shared with |
| GET | `/portfolios/{pid}/backpack?per_page=1` | |
| GET | `/portfolios/{pid}/collection-options` | |
| POST | `/portfolios/{pid}/mentions` | called when opening a collection (resolves @mentions); 201 |

### Collections
| Method | Path | Notes |
|---|---|---|
| GET | `/portfolios/{pid}/collections?page=1` | list |
| GET | `/portfolios/{pid}/collections/{cid}` | detail |
| GET | `/portfolios/{pid}/collections/{cid}/collection-goals?page=1&per_page=10` | goals attached to the collection |
| GET | `/portfolios/{pid}/collections/{cid}/evidence?not_in_a_goal=true&page=1` | evidence not under a goal |
| GET | `/portfolios/{pid}/goals/{gid}/evidence/in-collection/{cid}?page=1` | evidence per goal in a collection |
| GET | `/portfolios/{pid}/collections/{cid}/comments?page=1` | collection feedback |
| GET | `/portfolios/{pid}/collections/{cid}/shares?page=1` | |

Collection fields: `id, name, subtitle, description, color, is_private, portfolio_id,
position, section_id, goals_count, evidence_count, preferred_view,
total_evidence_duration, banner_position_data{dx,dy,scale},
last_import{id, imported_at, template_name}`.

### Evidence
| Method | Path | Notes |
|---|---|---|
| GET | `/portfolios/{pid}/evidence?order_by=created_at&order_direction=desc&page=1&per_page=20` | all evidence |
| GET | `/portfolios/{pid}/evidence/{eid}` | detail |
| GET | `/portfolios/{pid}/evidence/{eid}/versions?page=1` | version history |
| GET | `/portfolios/{pid}/evidence/{eid}/versions/latest` | current version (files, text) |
| GET | `/portfolios/{pid}/evidence/{eid}/versions/{vid}/co-creators` | |
| GET | `/portfolios/{pid}/evidence-version-files/{fid}/preview-url` | signed S3 URL for the file (eu-west-1) |
| GET | `/portfolios/{pid}/evidence/{eid}/collections` | which collections it's in |
| GET | `/portfolios/{pid}/evidence/{eid}/goals` | linked goals |
| GET | `/portfolios/{pid}/evidence/{eid}/sub-goals` | |
| GET | `/portfolios/{pid}/evidence/{eid}/comments?page=1` | feedback on the evidence |
| GET | `/portfolios/{pid}/evidence/{eid}/shares?page=1` | |
| GET | `/portfolios/{pid}/evidence/{eid}/shared-users?page=1` | |

### Goals & progress
| Method | Path | Notes |
|---|---|---|
| GET | `/portfolios/{pid}/goals?page=1&per_page=25` | |
| GET | `/portfolios/{pid}/goal-sets?page=1` | |
| GET | `/portfolios/{pid}/goal-options?page=1` | |
| GET | `/portfolios/{pid}/goal-set-options?page=1` | |
| GET | `/portfolios/{pid}/imported-templates/with-goals?page=1` | |
| GET | `/portfolios/{pid}/progress-review/reviews?per_page=1` | progress reviews |

Not mapped yet: Snapshots, My access & requests, notifications list, and every
write endpoint (create/edit evidence, comments, feedback requests).

## Getting a token automatically (optional)

From a logged-in Canvas session: GET the Canvas launch page HTML, take the
`form[action*="drieam"]` fields, POST them to `/lti/open_id`, follow the OIDC
redirects to `/lti/launches`, then pull the bearer token the app uses. This needs
your Canvas session cookie, so it's more fragile and more sensitive than pasting a
token every 8 hours. Start with the manual token.

## MCP design sketch

Env: `PORTFLOW_TOKEN` (bearer JWT), optional `PORTFLOW_CSRF`.
Read-only tools first:

- `whoami` → `/users/current` (+ portfolio id)
- `list_collections` → sections + collections
- `get_collection(collection_id)` → detail + goals + evidence per goal + comments
- `list_evidence(page)` / `get_evidence(evidence_id)` → detail + latest version + goals + comments
- `get_evidence_file_url(file_id)` → preview-url
- `list_goals` / `get_progress_reviews`

On 401: tell the user the token expired and how to copy a new one.

## Write endpoints (verified live 2026-11-25 on a test item, then trashed)

Bearer token alone is enough; `X-CSRF-Token` is **not** required for API writes.

### File upload (Rails ActiveStorage direct upload)
1. `POST /api/v1/direct-uploads`
   body `{"blob":{"filename","content_type","byte_size","checksum"}}` (checksum = base64 MD5)
   → `{id, signed_id, direct_upload:{url, headers}, ...}`
2. `PUT <direct_upload.url>` (S3, eu-west-1) with `direct_upload.headers`
   (Content-Type, Content-MD5, Content-Disposition) and the raw bytes → 200

### Evidence
- `POST /portfolios/{pid}/evidence` → 201
  `{"files":[{"signed_id","file_name","type"}],"collection_ids":[],"goal_ids":[],"activity_ids":[],"version_type":"file","name":"..."}`
- `PUT /portfolios/{pid}/evidence/{eid}` `{"description":"<p>…</p>"}` → 204
- `POST /portfolios/{pid}/evidence-versions/{versionId}/comments`
  `{"text":"<p>…</p>","created_by_role":"student","attachments":[]}` → 204
  (versionId = `GET …/evidence/{eid}/versions/latest` → `id`)
- `POST /portfolios/{pid}/evidence/{eid}/versions` → 201 (verified live, new version)
  `{"files":[{"signed_id","file_name","type"}, …],"existing_files":[],"version_type":"file","description":"<p>version note</p>"}`
  To keep a file from the latest version: add `{"signed_id": <latest.files[i].file.signed_id>, "file_name"}` to `files`
  and its `latest.files[i].id` (as a string) to `existing_files`. `description` (version note) is optional.
- Move to trash: UI "Move to trash bin" (restorable for 90 days via `/trash-bin/evidence/{id}/restore`)

### Seen in the app's code, not exercised live
| Method | Path |
|---|---|
| POST | `/portfolios/{pid}/collections/{cid}/comments` (assumed same body as evidence comments) |
| PUT | `/portfolios/{pid}/collections/{cid}` (assumed `{description}`) |
| POST | `/portfolios/{pid}/evidence/{eid}/link-to-collections` |
| POST | `/portfolios/{pid}/evidence/{eid}/link-to-goals-and-sub-goals` |
| POST | `/portfolios/{pid}/collections/{cid}/evidence`, `/collections/{cid}/goals/{gid}/evidence` |
| POST | `/portfolios/{pid}/comments/{id}/children` (reply) |
| PUT | `/portfolios/{pid}/comments/{id}` (edit comment) |
| POST | `/portfolios/{pid}/ad-hoc-feedback/invitations` (feedback request) |
| DELETE | `/portfolios/{pid}/evidence/{eid}`, `/collections/{cid}`, `/comments/...` (not exposed in the MCP) |
