# pont

Bridging the context between humans and agents

See [docs/](docs/README.md) for the [product overview](docs/overview.md), a [usage guide with examples](docs/usage.md), and [technical specifications](docs/technical.md) (including disk space), and [USER-STORY.md](USER-STORY.md) for the user stories.

## Quickstart

Requires Docker with Compose v2.

```sh
docker compose up -d --wait
```

The first start takes about a minute. No configuration is needed. To change ports or passwords, copy `.env.example` to `.env` and edit it.

| What                                                                   | URL                           | Default login             |
| ---------------------------------------------------------------------- | ----------------------------- | ------------------------- |
| pont                                                                   | <http://localhost:3000>       | —                         |
| Keycloak admin console (create pont user accounts in the `pont` realm) | <http://localhost:8080/admin> | `admin` / `admin`         |
| MinIO console (knowledge files)                                        | <http://localhost:9001>       | `pont` / `pont-minio-dev` |

Check that every service is up:

```sh
curl http://localhost:3000/api/health
```

The default passwords are for local development only. Change them in `.env` before running pont anywhere else.

### Creating users

pont has no self-signup: an admin creates every account.

1. Open the Keycloak admin console at <http://localhost:8080/admin> and sign in as the bootstrap admin.
2. Switch to the **pont** realm (top-left realm menu).
3. Go to **Users → Create user**, fill in a username and email, and create it.
4. On the user's **Credentials** tab, set a password. Leave **Temporary** on to make the user choose their own password at first login.

The user can now sign in at <http://localhost:3000>.

### Connecting Claude Code

1. Sign in to pont and open **API tokens** (top right).
2. Create a token. pont shows it once, together with the command to run.
3. Run that command. It looks like this:

   ```sh
   claude mcp add --transport http pont http://localhost:3000/mcp \
     --header "Authorization: Bearer pont_..."
   ```

Or, when working in this repository, use the included [`.mcp.json`](.mcp.json): it connects Claude Code to your local pont at `http://localhost:3000/mcp` and reads the token from the `PONT_API_TOKEN` environment variable, so no token is stored in the file:

```sh
export PONT_API_TOKEN=pont_...   # the token from API tokens
claude                          # approve the "pont" server when asked
```

Claude Code can then call pont's MCP tools as you:

* **Read:** `search`, `read_entry`, `list_entries`, `get_concept`, `list_concepts`
* **Propose** (reviewed by a person before anything changes): `propose_edit`, `propose_new_page`, `propose_concept`, `propose_alias`, `propose_relation`, and `list_my_proposals` to see what happened to them

Revoke a token on the same page when you no longer need it.

> Keycloak imports `infra/keycloak/pont-realm.json` only on its first start. After changing that file, run `docker compose down -v` to reset the data and import it again.

### Search

Press **⌘K** (or **Ctrl K**), or click **Search** in the sidebar. Search is hybrid: it matches by meaning, so plain-language questions work, and by exact terms such as metric names and acronyms. Agents get the same search through the MCP `search` tool.

How it works:

* Each page is split into chunks by headings, with a size limit. A page that fits in one chunk stays whole.
* A local embedding model ([bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)) runs inside the server, with no API key. On the first start it downloads about 35 MB into the `model-cache` volume, and search is ready a few seconds later.
* Chunks and their vectors are stored in Redis, which runs a vector search and a BM25 keyword search side by side. Their scores are combined, and results with weak meaning and no keyword match are dropped, so unrelated questions return nothing.
* The index updates about 1.5 seconds after a page is saved, moved, or deleted. On every start it catches up with MinIO, which remains the source of truth.

To rebuild the index from scratch, call `POST /api/search/reindex` as a signed-in user. The index also rebuilds itself when the embedding model or the chunking changes.

Tuning (environment variables on `server`):

| Variable                | Default                    | Meaning                                                         |
| ----------------------- | -------------------------- | --------------------------------------------------------------- |
| `EMBEDDING_MODEL`       | `Xenova/bge-small-en-v1.5` | Embedding model (changing it triggers a rebuild)                |
| `SEARCH_ALPHA_LONG`     | `0.7`                      | Weight of meaning versus keywords for questions of 3+ words     |
| `SEARCH_ALPHA_SHORT`    | `0.3`                      | The same weight for 1–2 word queries, which lean on exact terms |
| `SEARCH_MIN_SIMILARITY` | `0.62`                     | Minimum similarity for a result that matches no keywords        |

### Uploading files

Click **Upload** in the sidebar, then drop files or whole folders (or use **Choose files** / **Choose folder**). Folders keep their structure: `Handbook/Eng/On-call.md` becomes the page `Handbook/Eng/On-call` inside the folder you pick.

| File type                  | How it's imported                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `.md`, `.markdown`, `.txt` | As-is                                                                                                        |
| `.docx` (Word)             | Converted to Markdown: headings, lists, links, bold/italic, and tables (images are dropped)                  |
| `.html`, `.htm`            | Converted to Markdown the same way (scripts, styles, and embedded images are dropped)                        |
| `.pdf`                     | Text only: layout, tables, and images are not kept, and scanned PDFs (images of text) have no text to import |

Before anything is written, a preview lists every file with its destination page. Files that would replace an existing page are **skipped unless you tick "Replace existing"**; replaced pages keep their previous versions in history. Hidden files (such as `.DS_Store` and `.git/`) and unsupported types are skipped. Limits: 10 MB per file, 50 MB and 500 files per upload. Imported pages are searchable and available to agents a few seconds later.

### GitHub docs

Link a Markdown file in a GitHub repository (a README, or anything under `docs/`) to a Pont page, edit it in pont, and publish your changes as a pull request.

**Setup (once).** Register a GitHub OAuth App (*GitHub → Settings → Developer settings → OAuth Apps → New OAuth App*) with the authorization callback URL `http://localhost:3000/api/github/callback` (your pont address + `/api/github/callback`). Then either enter its client ID and a client secret in **Settings → Integrations → GitHub** (the secret is stored encrypted with `PONT_SECRET_KEY`, like the LLM key), or put them in `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and run `docker compose up -d`. The environment wins when set, and Settings then shows the app as set by the server, so an admin can lock it down (pont has no roles yet, so anyone signed in can change Settings). For GitHub Enterprise Server, also set `GITHUB_URL` and `GITHUB_API_URL`.

**Connect (once per person).** **Settings → Integrations → GitHub → Connect GitHub** signs you in to GitHub and lets pont act as you on repositories you can access (scope `repo`). Your token is encrypted with `PONT_SECRET_KEY`.

**Link a file.** **GitHub doc** in the sidebar: paste the file's GitHub link (for example `https://github.com/org/app/blob/main/README.md`) or enter the repository, branch, and path. The file becomes a page (by default `github/<owner>/<repo>/<file>`) that search and agents can read.

**Edit and publish.** Linked pages **don't autosave**: edits are a draft (kept in your browser, so a reload doesn't lose them) until you click **Publish**. The first publish commits your change to a new `pont/…` branch and opens a pull request into the linked branch, as you; later publishes add commits to the same pull request while it's open, and the editor shows the pull request's version meanwhile. When the pull request is merged (or the file changes on the branch), pont pulls the new content the next time someone opens the page, or right away with **Pull latest**. Pages show *From GitHub* versions in their history.

**Pull request status and history.** The page bar shows the open pull request's status (*Open*, *Draft*, *Approved*, *Changes requested*) and lists every pull request pont opened for the page, with who opened it, how many publishes went into it, and how it ended. Once a pull request is merged, pont deletes the `pont/…` branch it made (branches of pull requests closed without merging are kept). When the status changes, or the pull request is merged or closed, an open page says so.

**Changes on GitHub.** pont checks each linked file about once a minute using the file's blob SHA (a hash GitHub returns that changes whenever the file does, with ETags so an unchanged file costs nothing against GitHub's rate limit). Changes on the linked branch, including merges, are pulled into pont automatically; a page open in the editor asks you to **Refresh** instead of replacing what you're looking at. If the file changed on GitHub since your draft started, **Publish** warns you instead of overwriting the change, and offers **Publish anyway**.

**Reviews on linked pages.** The ✦ Review panel doesn't offer link fixes (dead links, missing ontology links) for linked pages, and **Apply** edits your unpublished draft rather than saving the page; it reaches GitHub with your next Publish.

Linked pages can only change through Publish: other ways of saving (agent proposals, review suggestions, link fixes) are refused for them, so pont never drifts from the repository. Branches whose names contain `/` need the repository, branch, and file entered separately rather than a pasted link.

### Page history

Every save is kept: MinIO bucket versioning stores each version, and deletes only add a delete marker. Open a page's **⋯ menu → Page history** to see every version with its author and where it came from (an agent proposal, a restore, or a move), the changes each version made, and the full page as it was. **Restore this version** saves that content as the newest version, so nothing is overwritten.

History also works for pages that have since been deleted, at `#/history/<page path>`; restoring a version brings the page back. A page moved to a new path links back to its history at the old path.

### Agent proposals

Agents connected through MCP can suggest fixes when they find something missing, outdated, or contradictory, but they can never change anything themselves:

* `propose_edit` takes exact find-and-replace edits (each `find` must match the page exactly once), and `propose_new_page` takes a new Markdown page. pont stores each proposal as a unified diff (`proposals/<id>.patch`) against the page version the agent saw.
* `propose_concept`, `propose_alias`, and `propose_relation` must quote supporting passages (checked against the pages) and join the review queue on the **Ontology** page.

Page proposals appear on the **Agent Proposals** page (with a count in the sidebar and a banner on affected pages). Each shows the agent's reason and a diff, and can be **approved**, **edited and approved**, or **rejected** with a note the agent can read. If the page changed after the proposal was made, it is flagged: the diff is shown against the current version when it still applies, and can only be edited in by hand when it doesn't. Versions saved from proposals record the proposal and who proposed it, with the approver as author. Each user can have at most 25 proposals waiting for review.

### Ontology

The **Ontology** page holds the concepts your documentation defines (metrics, processes, decisions, policies, systems, teams, and terms) and typed relationships between them, such as *Weekly active users calculated from Sessions*. It is stored as `ontology/ontology.yaml` in the bucket, versioned like the pages.

The ontology is built by two AI agents ([Strands Agents](https://strandsagents.com) TypeScript SDK) that you run with **Calculate**:

1. pont compares every page with its state at the last calculation and finds the pages that were added, changed, or deleted. Changed pages are shown to the agents as diffs.
2. A confirmation dialog lists those pages and estimates tokens and cost. **Calculating sends the changed pages to the LLM configured in Settings and incurs its costs.**
3. The *maintain* agent checks what the ontology says about changed and deleted pages and recommends updates or deletions. The *create* agent reads new and changed content and recommends new concepts, aliases, and relationships, checking the existing ontology first so it doesn't duplicate anything.
4. Every recommendation must quote the page passage that supports it; pont checks that the quote is really there before saving it. **Nothing changes until someone approves it** on the Ontology page. Rejected recommendations aren't suggested again.

Every concept and relationship has its own page (`#/concept/<id>`, `#/relation/<id>`) where people can edit or delete it directly, add relationships, and see which pages link to it. Relationships can have a name and description (for example *Peanut Butter & Jelly*), and **＋ New concept** on the Ontology page adds one by hand.

**Linking text to the ontology, other pages, and headings.** In a page, type `[[` followed by a few letters; select text and press **⌘⇧K** (Ctrl+Shift+K) or click the link button at the end of the formatting toolbar; or type `/` and choose **Advanced → Link to page or concept**. A picker lists matching concepts, relationships, pages, and headings (Link to | Type | Description), with an option to create a new concept on the spot. Add `#` for a heading: `[[#escal` for a heading on this page, `[[onboarding#escal` for one on another page. Page links are saved as `[text](#/p/<path>)` and heading links as `[text](#/p/<path>?section=<heading>)`. Renaming or moving a page updates links to it on every other page automatically. Each page's **✦ Review** panel lists its links whose page, heading, or concept is gone, with a suggested new destination and one-click fixes. The link is saved as plain Markdown, `[peanut butter](#/concept/peanut-butter)`, so agents can follow it with the `get_concept` MCP tool. ⌘-click (Ctrl-click) a link in the editor to open its concept.

Only one calculation runs at a time, and it can be cancelled. If a run fails or is cancelled, the next one looks at the same changes again. Each agent call is capped in model calls, and every run records its token usage.

### Trivia

**Trivia** (under **Games** in the sidebar) asks multiple-choice questions written on the fly from a random section of your documentation: +1 for a correct answer, −1 for a wrong one. The leaderboard shows this week (from Monday) and all time. After each question, **Fact check this section** opens the page the question came from, scrolled to that section, so anyone who spots something out of date can fix it right away.

Trivia needs an LLM. Set it up once for everyone under **Settings**:

* **Anthropic:** Claude models through the Anthropic API (default model `claude-opus-5-5`).
* **OpenAI-compatible:** OpenAI, or any server with the same API, such as Ollama (`http://localhost:11434/v1` from your machine, or `http://host.docker.internal:11434/v1` from inside Docker), vLLM, or LiteLLM.

The API key is encrypted in Postgres with `PONT_SECRET_KEY` and never sent back to the browser. **Set `PONT_SECRET_KEY` in `.env` to a long random value** (for example `openssl rand -base64 32`) before entering a real key; if you change it later, enter the API key again. There are no roles yet, so any signed-in user can change these settings.

**Flashcards** and **Match** (tabs next to Trivia under **Games**) quiz people on the approved ontology: flashcards for concepts and their definitions, and a timed matching game for relationships. They run in the browser and need no LLM.

## Services

| Service    | Role                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `frontend` | React app, served by nginx, which also proxies `/api` and `/mcp` to the server                                      |
| `server`   | Node.js REST API for the frontend, and the MCP endpoint for agents (`/mcp`)                                         |
| `minio`    | Stores knowledge files as Markdown, with bucket versioning for history (`minio-init` creates the bucket on startup) |
| `redis`    | Redis Stack: document chunks and vectors for hybrid search                                                          |
| `postgres` | Databases for Keycloak and pont                                                                                     |
| `keycloak` | Login and user accounts (the `pont` realm is imported on startup)                                                   |

## Development

```sh
docker compose up -d --build   # rebuild after code changes
docker compose logs -f server  # follow server logs
docker compose down            # stop (keeps data)
docker compose down -v         # stop and delete all data
```
