# Technical specifications

- [Architecture](#architecture)
- [Services and images](#services-and-images)
- [Disk space](#disk-space)
- [Memory](#memory)
- [Tools and libraries](#tools-and-libraries)
- [Data and storage](#data-and-storage)
- [Search](#search)
- [LLM features](#llm-features)
- [Security model](#security-model)
- [Configuration](#configuration)
- [Limits](#limits)

## Architecture

```
                    browser                         Claude Code / any MCP client
                       │                                       │
                       ▼                                       │  Authorization: Bearer pont_…
  ┌──────────────────────────────────────────┐                 │
  │ frontend  (nginx + React)        :3000   │◀────────────────┘
  │   /        → React app                    │
  │   /api/*   → server                       │
  │   /mcp     → server                       │
  └───────────────────┬──────────────────────┘
                      ▼
  ┌──────────────────────────────────────────┐      ┌──────────────────────┐
  │ server  (Node.js 22, TypeScript, Express) │─────▶│ keycloak    :8080    │  login (OIDC)
  │   REST API · MCP endpoint · search index │      └──────────┬───────────┘
  │   local embedding model · LLM features   │                 ▼
  └──┬────────────────┬──────────────────┬───┘      ┌──────────────────────┐
     ▼                ▼                  ▼          │ postgres             │
  ┌────────┐   ┌────────────────┐  ┌──────────┐     │  keycloak + pont DBs │
  │ minio  │   │ redis (Stack)  │  │ LLM API  │     └──────────────────────┘
  │ pages, │   │ chunks, vectors│  │(optional)│
  │ history│   └────────────────┘  └──────────┘
  └────────┘
```

- **The server is the only service that touches the data stores.** The browser and agents go through nginx to the server; nothing else is exposed except Keycloak (for login) and the MinIO console.
- **MinIO is the source of truth** for pages and the ontology. Redis holds a search index that can always be rebuilt from MinIO. Postgres holds accounts, tokens, settings, and review queues.
- Everything runs in one Docker Compose project. The only outside calls are the LLM API (only for trivia, page review, and ontology calculation, and only when a person starts them) and a one-time download of the embedding model.

## Services and images

| Service | Image | Purpose | Port on your machine |
|---|---|---|---|
| `frontend` | `pont-frontend` (built: `nginx:1.27-alpine`) | Serves the React app; proxies `/api` and `/mcp` | `3000` (`PONT_PORT`) |
| `server` | `pont-server` (built: `node:22-slim`) | REST API, MCP endpoint, search indexing, LLM features | — (internal `4000`) |
| `minio` | `cgr.dev/chainguard/minio:latest` | S3-compatible file store with bucket versioning | `9001` console (`MINIO_CONSOLE_PORT`) |
| `minio-init` | `cgr.dev/chainguard/minio:latest` | One-shot: creates the bucket and turns on versioning | — |
| `redis` | `redis/redis-stack-server:7.4.0-v6` | Search index: chunks, vectors, BM25 | — |
| `postgres` | `postgres:16-alpine` | Databases for Keycloak and pont | — |
| `keycloak` | `quay.io/keycloak/keycloak:26.4` | Login, user accounts (`pont` realm imported on first start) | `8080` (`KEYCLOAK_PORT`) |

The server image uses Debian slim rather than Alpine because the embedding model runs on onnxruntime, whose native binaries need glibc.

## Disk space

Measured on a running install (Docker Desktop, Apple silicon, October 2026) with a small knowledge base of a few pages.

### Images

| Image | Size on disk |
|---|---|
| `pont-server` | 1.05 GB |
| `redis/redis-stack-server:7.4.0-v6` | 472 MB |
| `quay.io/keycloak/keycloak:26.4` | 458 MB |
| `postgres:16-alpine` | 288 MB |
| `cgr.dev/chainguard/minio` | 159 MB |
| `pont-frontend` | 54 MB |
| **Total** | **≈ 2.5 GB** |

The server image is the largest because it carries the embedding runtime (onnxruntime and transformers.js), the AWS S3 SDK, the Anthropic and OpenAI SDKs, Strands Agents, and the document converters.

### Containers and volumes

| What | Size | Grows with |
|---|---|---|
| Keycloak container layer (its optimized build at first start) | 162 MB | — |
| `model-cache` volume (bge-small-en-v1.5) | 35 MB | Only if you change `EMBEDDING_MODEL` |
| `postgres-data` volume (Postgres system files plus both databases; pont's database was 9 MB, Keycloak's 13 MB) | 80 MB | Users, proposals, reviews, trivia history |
| `minio-data` volume | 11 MB | Pages **and every saved version** of them |
| `redis-data` volume | < 1 MB | Number of chunks (snapshot of the index) |
| **Total at install** | **≈ 0.3 GB** | |

### Building the images

`docker compose up` builds `pont-server` and `pont-frontend` locally. Building pulls the base images (`node:22-slim`, `node:22-alpine`, `nginx:1.27-alpine`) and keeps a build cache with installed `node_modules`. Expect roughly **1.5–3 GB of build cache** after the first build (an estimate; it depends on your Docker version). Every rebuild after a code change adds more: a development machine that rebuilt pont many times had 21 GB of build cache. Reclaim it with:

```sh
docker builder prune
```

### How much to plan for

| Use | Free disk |
|---|---|
| Minimum for a first install (images, build, data) | **5 GB** |
| Comfortable, with room for rebuilds and growth | **10 GB** |

### How data grows

- **Pages are small.** A typical Markdown page is 2–20 KB.
- **History keeps every version.** MinIO stores a full copy of a page on each save, and the editor autosaves about 0.7 seconds after you stop typing. A page edited over many sessions can have hundreds of versions; at 10 KB each, 500 versions is about 5 MB. History is what makes restore possible; there is no automatic pruning yet.
- **The search index** stores each chunk's text, a normalized copy, and a 384-dimension vector (1.5 KB). Plan on roughly 3–5 KB of Redis memory per chunk, and about 4–6 chunks per page; 10,000 pages is around 200–300 MB (an estimate).

## Memory

Measured at rest on the same install:

| Container | Memory |
|---|---|
| keycloak | 740 MB |
| server (including the loaded embedding model) | 375 MB |
| minio | 270 MB |
| postgres | 46 MB |
| redis | 21 MB |
| frontend | 7 MB |
| **Total** | **≈ 1.5 GB** |

Give Docker at least **2 GB** of memory, and **4 GB** to be comfortable. Indexing a large upload briefly uses more CPU and memory in the server while it embeds the new chunks.

## Tools and libraries

### Server (`server/`)

| Library | Version | Used for |
|---|---|---|
| Node.js | 22 | Runtime |
| TypeScript | 7 | Language (strict mode) |
| Express | 5 | REST API |
| `@modelcontextprotocol/sdk` | 1.32 | MCP endpoint (Streamable HTTP, stateless) |
| `@aws-sdk/client-s3` | 3 | Reading and writing pages in MinIO, with conditional writes for conflict protection |
| `redis` (node-redis) | 6 | Search index (RediSearch: HNSW vectors and BM25) |
| `@huggingface/transformers` | 4.3 | Local embeddings (`Xenova/bge-small-en-v1.5`, 384 dimensions) |
| `pg` | 8 | Postgres |
| `jose` | 6 | Verifying Keycloak access tokens (JWT) |
| `@anthropic-ai/sdk` | 0.132 | Claude: structured outputs for trivia and page review; the model behind the ontology agents |
| `openai` | 7 | Any OpenAI-compatible endpoint |
| `@strands-agents/sdk` | 1.20 | Agent harness for the ontology workflows |
| `zod` | 4 | Schemas for MCP tools and LLM outputs |
| `diff` | 9 | Unified diffs for proposals and history |
| `yaml` | 2 | The ontology file |
| `mammoth`, `turndown` (+ GFM plugin), `unpdf`, `multer` | — | Converting uploaded Word, HTML, and PDF files to Markdown |

### Frontend (`frontend/`)

| Library | Version | Used for |
|---|---|---|
| React | 19 | UI |
| Vite | 8 | Build |
| Milkdown Crepe / Kit | 7.22 | Notion-style Markdown editor (ProseMirror) |
| `keycloak-js` | 26 | Sign-in (OIDC authorization code with PKCE) |

### Infrastructure

| Tool | Version | Used for |
|---|---|---|
| Docker Compose | v2 | Running the stack |
| MinIO (Chainguard image) | latest | S3-compatible storage with bucket versioning |
| Redis Stack Server | 7.4 | Redis with the search module |
| PostgreSQL | 16 | Databases |
| Keycloak | 26.4 | Identity |
| nginx | 1.27 | Static files and reverse proxy |

## Data and storage

**MinIO bucket** (`pont` by default, versioning on):

| Key | Contents |
|---|---|
| `knowledge/<path>.md` | Each page, as plain Markdown. Object metadata records the author, plus where a version came from (proposal, review, restore, move) |
| `ontology/ontology.yaml` | The approved ontology: concepts and relationships |
| `proposals/<id>.patch` | Agent page proposals, as unified diffs |

**Postgres** (`pont` database): API tokens (hashes only), settings (with the encrypted LLM key), trivia questions and scores, ontology runs, page snapshots and recommendations, page proposals, page reviews, page moves (so dead links can point to where a page went), and an index of which pages link to which ontology items (rebuilt on every start).

**Redis**: one hash per chunk (`pont:chunk:*`) in the index `idx:pont:chunks`, plus which version of each page is indexed.

Back up the `minio-data` and `postgres-data` volumes. Redis can be rebuilt from MinIO (`POST /api/search/reindex`).

## Search

- **Chunking:** by Markdown headings with a token limit; long sections are split further. Each chunk is embedded with its page title and heading path, so it keeps its context. A page that fits in one chunk is never split.
- **Retrieval:** a vector (KNN, HNSW, cosine) search and a BM25 keyword search run side by side over 30 candidates each.
- **Fusion:** `score = α · similarity + (1 − α) · keyword`, where `keyword` is scaled by how much of the query the chunk covers. α is 0.3 for 1–2 word queries (they lean on exact terms) and 0.7 for longer questions. Results with similarity under 0.62 and no keyword match covering half the query are dropped.
- **Freshness:** a page is re-indexed about 1.5 seconds after it's saved, moved, or deleted. On start, the index catches up with MinIO and rebuilds itself if the model or chunking changed.

These ideas are adapted from [Onyx](https://github.com/onyx-dot-app/onyx); pont doesn't depend on it or reuse its code.

## Links and dead links

Pages link to each other as `#/p/<path>`, to headings as `#/p/<path>?section=<heading>`, and to the ontology as `#/concept/<id>` or `#/relation/<id>`, all plain Markdown. The server keeps every page's headings in memory for the link picker. The dead-link check (no LLM) parses every internal link outside code and flags:

| Problem | Suggested fix |
|---|---|
| The page was moved or renamed | Where it went, following chains of moves recorded in `page_moves` (moves from before this feature are backfilled once from page history) |
| The page was deleted, or never existed | A page with the same (or a very similar) name, if there is one |
| The heading is gone | The closest heading on that page by text similarity, or the page itself |
| The concept or relationship is gone | One with the link's text as its name or alias, or the closest by name |

Fixes rewrite every link with that destination on the page and save a new version, marked *Link fix* in the history.

**Moves update links.** The server keeps, in memory, which pages each page links to. When a page is moved or renamed, its links to itself are rewritten as part of the move, and every other page that links to it gets a new version with those links pointed at the new path (headings kept), by the person who moved it and marked *Links updated*. A page saved at the same moment is retried; anything still missed shows up as a dead link with the new path suggested.

## LLM features

All LLM features use the provider set once in **Settings**: Anthropic (default model `claude-opus-5-5`) or any OpenAI-compatible endpoint. Answers are requested as structured output and validated against a schema before use.

| Feature | Started by | What is sent | Guardrails |
|---|---|---|---|
| Trivia | A person asking for a question | One random chunk | One question per request |
| Page review | A person, after a cost estimate | The page, up to 20 related passages (24,000 characters) from other pages, and up to 40 unlinked ontology terms | Quotes are checked against the page; invented ones are dropped; nothing changes until a finding is applied |
| Ontology calculation | A person, after a cost estimate | Pages changed since the last run, in batches of about 24,000 characters | At most 24 model calls per batch; one run at a time; cancellable; every recommendation must quote its evidence |

Costs are estimated from list prices for known Claude models; other models show token counts only.

## Security model

- **Sign-in:** Keycloak (OIDC authorization code with PKCE). The server verifies each access token's signature, issuer, and client. There is no self-signup; an admin creates accounts.
- **Agents:** personal API tokens (`pont_` plus 32 random bytes). pont stores only a SHA-256 hash. Every MCP request acts as the token's owner.
- **Secrets:** the LLM API key is encrypted with AES-256-GCM using `PONT_SECRET_KEY` and never returned to the browser.
- **No roles yet:** everyone who can sign in can read and edit everything, including Settings.
- **Not production-hardened:** the defaults are development passwords and plain HTTP. Change every password in `.env`, set `PONT_SECRET_KEY`, and put pont behind TLS before exposing it. Deleting a user in Keycloak doesn't yet revoke their pont API tokens; revoke those first.

## Configuration

Copy `.env.example` to `.env` to change any of these:

| Variable | Default | Meaning |
|---|---|---|
| `PONT_PORT` | `3000` | Port for pont |
| `KEYCLOAK_PORT` | `8080` | Port for Keycloak (sign-in and admin console) |
| `MINIO_CONSOLE_PORT` | `9001` | Port for the MinIO console |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `pont` / `pont-minio-dev` | MinIO credentials |
| `MINIO_BUCKET` | `pont` | Bucket for pages, ontology, and proposals |
| `POSTGRES_PASSWORD` | `postgres-dev` | Postgres superuser |
| `KEYCLOAK_DB_USER` / `KEYCLOAK_DB_PASSWORD` | `keycloak` / `keycloak-db-dev` | Keycloak's database login |
| `PONT_DB_NAME` / `PONT_DB_USER` / `PONT_DB_PASSWORD` | `pont` / `pont` / `pont-db-dev` | pont's database |
| `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` | `admin` / `admin` | Bootstrap Keycloak admin |
| `PONT_SECRET_KEY` | a development value | Encrypts stored secrets; set a long random value |

Search tuning (on the `server` service): `EMBEDDING_MODEL`, `SEARCH_ALPHA_SHORT`, `SEARCH_ALPHA_LONG`, `SEARCH_MIN_SIMILARITY`; see the [README](../README.md#search).

## Limits

| Limit | Value |
|---|---|
| Upload: per file / per upload / files per upload | 10 MB / 50 MB / 500 |
| Pending page proposals per user | 25 |
| Edits per `propose_edit` call | 20 |
| `search` results per call | default 8, at most 20 |
| Page size for a review | 80,000 characters |
| Review findings | up to 12 suggestions and 8 conflicts |
| Concurrent page reviews | 3 (one per page) |
| Concurrent ontology calculations | 1 |
