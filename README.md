# pont
Bridging the context between humans and agents

See [USER-STORY.md](USER-STORY.md) for the product vision, MVP scope, and user stories.

## Quickstart

Requires Docker with Compose v2.

```sh
docker compose up -d --wait
```

The first start takes about a minute. No configuration is needed. To change ports or passwords, copy `.env.example` to `.env` and edit it.

| What | URL | Default login |
|---|---|---|
| pont | http://localhost:3000 | — |
| Keycloak admin console (create pont user accounts in the `pont` realm) | http://localhost:8080/admin | `admin` / `admin` |
| MinIO console (knowledge files) | http://localhost:9001 | `pont` / `pont-minio-dev` |

Check that every service is up:

```sh
curl http://localhost:3000/api/health
```

The default passwords are for local development only. Change them in `.env` before running pont anywhere else.

### Creating users

pont has no self-signup: an admin creates every account.

1. Open the Keycloak admin console at http://localhost:8080/admin and sign in as the bootstrap admin.
2. Switch to the **pont** realm (top-left realm menu).
3. Go to **Users → Create user**, fill in a username and email, and create it.
4. On the user's **Credentials** tab, set a password. Leave **Temporary** on to make the user choose their own password at first login.

The user can now sign in at http://localhost:3000.

### Connecting Claude Code

1. Sign in to pont and open **API tokens** (top right).
2. Create a token. pont shows it once, together with the command to run.
3. Run that command. It looks like this:

   ```sh
   claude mcp add --transport http pont http://localhost:3000/mcp \
     --header "Authorization: Bearer pont_..."
   ```

Claude Code can then call pont's MCP tools as you: `search`, `read_entry`, and `list_entries`. Revoke a token on the same page when you no longer need it.

> Keycloak imports `infra/keycloak/pont-realm.json` only on its first start. After changing that file, run `docker compose down -v` to reset the data and import it again.

### Search

Press **⌘K** (or **Ctrl K**), or click **Search** in the sidebar. Search is hybrid: it matches by meaning, so plain-language questions work, and by exact terms such as metric names and acronyms. Agents get the same search through the MCP `search` tool.

How it works:

- Each page is split into chunks by headings, with a size limit. A page that fits in one chunk stays whole.
- A local embedding model ([bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)) runs inside the server, with no API key. On the first start it downloads about 35 MB into the `model-cache` volume, and search is ready a few seconds later.
- Chunks and their vectors are stored in Redis, which runs a vector search and a BM25 keyword search side by side. Their scores are combined, and results with weak meaning and no keyword match are dropped, so unrelated questions return nothing.
- The index updates about 1.5 seconds after a page is saved, moved, or deleted. On every start it catches up with MinIO, which remains the source of truth.

To rebuild the index from scratch, call `POST /api/search/reindex` as a signed-in user. The index also rebuilds itself when the embedding model or the chunking changes.

Tuning (environment variables on `server`):

| Variable | Default | Meaning |
|---|---|---|
| `EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model (changing it triggers a rebuild) |
| `SEARCH_ALPHA_LONG` | `0.7` | Weight of meaning versus keywords for questions of 3+ words |
| `SEARCH_ALPHA_SHORT` | `0.3` | The same weight for 1–2 word queries, which lean on exact terms |
| `SEARCH_MIN_SIMILARITY` | `0.62` | Minimum similarity for a result that matches no keywords |

### Trivia

**Trivia** (in the sidebar) asks multiple-choice questions written on the fly from a random section of your documentation: +1 for a correct answer, −1 for a wrong one. The leaderboard shows this week (from Monday) and all time. After each question, **Fact check this section** opens the page the question came from, scrolled to that section, so anyone who spots something out of date can fix it right away.

Trivia needs an LLM. Set it up once for everyone under **Settings**:

- **Anthropic:** Claude models through the Anthropic API (default model `claude-opus-5-5`).
- **OpenAI-compatible:** OpenAI, or any server with the same API, such as Ollama (`http://localhost:11434/v1` from your machine, or `http://host.docker.internal:11434/v1` from inside Docker), vLLM, or LiteLLM.

The API key is encrypted in Postgres with `PONT_SECRET_KEY` and never sent back to the browser. **Set `PONT_SECRET_KEY` in `.env` to a long random value** (for example `openssl rand -base64 32`) before entering a real key; if you change it later, enter the API key again. There are no roles yet, so any signed-in user can change these settings.

## Services

| Service | Role |
|---|---|
| `frontend` | React app, served by nginx, which also proxies `/api` and `/mcp` to the server |
| `server` | Node.js REST API for the frontend, and the MCP endpoint for agents (`/mcp`) |
| `minio` | Stores knowledge files as Markdown, with bucket versioning for history (`minio-init` creates the bucket on startup) |
| `redis` | Redis Stack: document chunks and vectors for hybrid search |
| `postgres` | Databases for Keycloak and pont |
| `keycloak` | Login and user accounts (the `pont` realm is imported on startup) |

## Development

```sh
docker compose up -d --build   # rebuild after code changes
docker compose logs -f server  # follow server logs
docker compose down            # stop (keeps data)
docker compose down -v         # stop and delete all data
```
