# pont — User Stories

> *pont* (French: "bridge") — bridging the context between humans and agents.

## Problem

Tools for organizational knowledge fall into two camps:

- **Documentation-focused** tools are built for humans to read and write, but agents can't use them well.
- **Agent-focused** tools (MCP servers, retrieval tools) give agents context, but humans can't easily see, curate, or trust what the agents are working from.

Teams end up stitching together tools that each cover only part of the picture. pont does both jobs in one system. Humans own and work with the knowledge, agents use it through MCP, and agents can suggest improvements that a human must approve before they take effect.

## What "context" means

Any domain knowledge specific to an organization, for example:

- **Business intelligence:** metrics, definitions, how the business works
- **Decision making:** what was decided, why, and by whom
- **Processes:** how things get done in this organization

## Vision

Context flows **both ways** across the bridge:

```
 Humans ──── author, browse, curate ────▶ ┌──────┐ ──── read context (MCP) ────▶ Agents
                                          │ pont │
 Humans ◀── review & approve/reject ───── └──────┘ ◀── propose updates (MCP) ─── Agents
```

**Success:** pont is quick and easy to set up and use, and easy to maintain after that.

## Product shape

- **MCP server:** how agents read context and submit proposed updates.
- **Front-end UI:** how humans browse, write, and curate knowledge, and review what agents propose.

pont is **open source**.

## Technical direction

| Area | Decision |
|---|---|
| Language / runtime | Node.js |
| Storage | Knowledge lives as **files**, either on a local file system or in blob storage. The MVP uses **MinIO** (S3-compatible) only |
| File format | **Plain Markdown** (no frontmatter) |
| Frontend | **React** |
| File layout | Entries are stored as-is: `knowledge/<path>.md` |
| History | **MinIO bucket versioning**: every write keeps the previous version |
| Proposals (post-MVP) | **Unified diff files** in git-diff format at `proposals/<id>.patch`. Approving one applies the patch and writes the file back. No git server needed |
| Users | **Several users, with login required** in the frontend and on the MCP server. No roles in the MVP: every logged-in user has full access |
| Identity | **Keycloak**, self-hosted in the Compose stack, with pont-managed accounts (username/email and password). No external identity providers yet |
| Account storage | **Postgres**: Keycloak's database, plus pont's API token table |
| Account creation | **Admin-created only**, through the Keycloak admin console. No self-signup. The admin is a bootstrap Keycloak admin account set at deploy time |
| Agent credentials | **Personal API tokens issued by pont** (not Keycloak): pont stores only a hash of each token in Postgres, linked to the user's Keycloak ID. Each user creates their own, so agent activity is tied to that user |
| Backend | **One small Node.js server** that serves the frontend's REST API and the MCP endpoint (HTTP/SSE). It is the only service that holds MinIO credentials |
| Chunks and vectors | **Redis Stack**, a key-value store with built-in vector search. Each Markdown file is split into chunks, and each chunk is stored as a hash holding its Markdown, a normalized copy for keyword search, its embedding vector, and metadata (source path, heading path). The index records which version of each file it holds and catches up with MinIO on every start. MinIO stays the source of truth, so the index can always be rebuilt from it |
| Embeddings | **Local model**, `bge-small-en-v1.5` (384 dimensions) through transformers.js, running inside the Node.js server. No API key, works offline after a one-time download. Model files are cached in a Docker volume |
| Chunking | **By Markdown headings, with a size limit.** A section that is too long is split further, and short sibling sections may be merged. Each chunk is prefixed with its file title and heading path before embedding |
| Search | **Hybrid: vector plus keyword.** Redis Stack runs a vector (KNN) search and a full-text (BM25) search. Scores are combined with a tunable weighting that leans on keywords for 1–2 word queries and on meaning for longer questions, and keyword scores are scaled by how much of the query a chunk covers. Results with weak meaning and no keyword match are dropped, so unrelated questions return nothing |
| First agent client | **Claude Code** |
| MCP transport | **HTTP/SSE** |
| Capturing knowledge | Humans write it on purpose. Nothing is pulled in automatically |
| Delivering knowledge | **On demand:** MCP tools return context when an agent calls them. Nothing is injected at session start |
| Deployment | **Docker Compose** |

## MVP

The smallest working version of pont is **a single Docker Compose application with six services**:

```
docker compose up
 ├── frontend   (React)    humans browse and write Markdown knowledge entries
 ├── server     (Node.js)  REST API for the frontend + MCP endpoint for Claude Code (HTTP/SSE)
 ├── minio                 file store for knowledge files (source of truth)
 ├── redis                 Redis Stack: document chunks and their vectors, for semantic search
 ├── keycloak              login and user accounts
 └── postgres              Keycloak's database
```

The MVP works when someone can run `docker compose up`, log in, write a knowledge entry in the frontend, and have Claude Code find that entry by meaning (semantic search) and read it through the MCP server. The frontend never talks to MinIO directly. All reads and writes go through the Node.js server, which serves both humans (REST) and agents (MCP).

### Out of scope for the MVP
- **Agent-proposed changes and the review flow (Epic 5)**: this comes after the MVP
- A local file system backend (the MVP supports MinIO only)
- Roles and permissions: every logged-in user has full access
- Logging in with external identity providers (Google, GitHub, corporate SSO)
- Privacy and security hardening beyond login (for example, encryption, audit compliance)
- Automatic import from existing sources (docs, tickets, chat)
- Injecting context into agent sessions automatically
- First-class support for agent clients other than Claude Code (any MCP client may still work)

### Ideas borrowed from Onyx

pont reuses design ideas from [Onyx](https://github.com/onyx-dot-app/onyx) (MIT-licensed outside its `ee/` folders). It does not depend on Onyx or copy its Python code. Instead, pont rewrites these ideas in Node.js:

- **Hybrid retrieval:** combine vector and keyword results with a tunable weighting instead of using either one alone
- **Title-aware chunking:** prefix each chunk with its document title (and, in pont, the heading path) so chunks keep their context once separated from the file
- **Size-capped chunks with document awareness:** chunk to a token limit, and skip splitting when a whole document fits in one chunk
- **An MCP search tool built for agents:** one search tool returning ranked, cited chunks, plus read-only listings of what is indexed, so an agent can narrow its search first
- **Personal access tokens for MCP clients**, matching pont's per-user agent tokens

## Personas

| Persona | Who they are | What they need |
|---|---|---|
| **Domain Expert** (primary) | Anyone with domain knowledge: business, process, decisions | A simple way to capture and maintain what they know, and confidence that agents use it correctly |
| **AI Engineer** (secondary) | Builds agents and connects them to MCP tools | Reliable, useful MCP tools that give agents the right context with little setup |
| **Agent** (system actor) | An AI agent connected through MCP | Structured, findable context, and a channel to report gaps or outdated information |

---

## Epic 1 — Fast setup

**1.1** As a **Domain Expert**, I want to stand up pont quickly with minimal configuration, so that I can start capturing knowledge on day one.
- [ ] `docker compose up` starts the frontend, the Node.js server, MinIO, Redis Stack, Keycloak, and Postgres with no other setup
- [ ] On startup, the vector index is created if it doesn't exist
- [ ] Default configuration works out of the box, including MinIO credentials and the bucket being created on startup with versioning turned on
- [ ] A pont Keycloak realm and client are imported on startup, so login works with no manual Keycloak setup
- [ ] There is a clear first-run experience with no required up-front schema design

**1.2** As an **AI Engineer**, I want to connect Claude Code to pont's MCP server with a single config entry, so that integration takes minutes, not days.
- [ ] Docs include a copy-paste `claude mcp add` command or `.mcp.json` snippet
- [ ] Once connected, Claude Code can list and read context right away

## Epic 2 — Users and login

**2.1** As a **Domain Expert**, I want to log in to pont with my own account, so that my changes are attributed to me and only my team can see our knowledge.
- [ ] The frontend requires login through Keycloak before anyone can view or edit knowledge
- [ ] Several users can have pont-managed accounts (username/email and password) on the same pont instance
- [ ] Accounts are created by an admin in the Keycloak admin console. There is no self-signup
- [ ] A bootstrap admin account is configured through environment variables in the Compose file
- [ ] Every logged-in user can read and edit everything (no roles in the MVP)
- [ ] Every saved version records the logged-in user as its author (stored as object metadata)

**2.2** As an **AI Engineer**, I want Claude Code to authenticate to the MCP server, so that only authorized agents can read the organization's knowledge.
- [ ] The MCP server rejects requests that don't carry valid credentials
- [ ] Each user can create, view, and revoke their own personal API tokens from the frontend
- [ ] pont issues the tokens. The full token is shown once at creation, and only a hash is stored in Postgres
- [ ] Every MCP request is attributed to the user who owns the token
- [ ] The Claude Code config snippet from story 1.2 includes the user's token

## Epic 3 — Humans author and work with knowledge

**3.1** As a **Domain Expert**, I want to write and organize domain knowledge (BI, decisions, processes) in a simple interface, so that it is captured in one place.
- [ ] I can create, edit, and organize knowledge entries without technical skills
- [ ] Each entry is saved as a file in the file store (MinIO in the MVP)
- [ ] The interface is easy to understand without training

**3.2** As a **Domain Expert**, I want to browse and search existing knowledge, so that I can find and check what agents are working from.
- [ ] I can find any entry by browsing, or by searching in plain language (hybrid vector plus keyword search)
- [ ] I can see what an agent sees for a given entry

**3.3** As a **Domain Expert**, I want to record decisions together with their reasoning, so that both humans and agents understand *why*, not just *what*.
- [ ] A decision entry can capture the decision, its reasoning, and who made it

**3.4** As a **Domain Expert**, I want to upload existing documents, single files or whole folders, so that I don't have to retype knowledge that already exists.
- [x] Markdown and text import as-is; Word, HTML, and PDF are converted to Markdown (PDF as text only)
- [x] Folder uploads keep their structure as pont folders
- [x] A preview shows each file's destination page before anything is written; existing pages are only replaced when ticked, and keep their history

## Epic 4 — Agents use context through MCP

**4.1** As an **Agent**, I want to retrieve relevant organizational context through MCP tools, so that my output follows how this organization actually works.
- [ ] MCP tools support finding and reading knowledge entries
- [ ] Context is returned only when a tool is called (on demand)
- [ ] Results are structured and focused enough to actually help the agent (an unhelpful tool is a reason users drop pont)

**4.2** As an **AI Engineer**, I want MCP tools that are well described and predictable, so that agents pick the right tool and I can trust their behavior.
- [ ] Every tool has a clear name, description, and input schema
- [ ] Tool behavior is documented and consistent

**4.3** As an **Agent**, I want to search knowledge by meaning and get back the most relevant chunks, so that I get focused context without reading whole files.
- [ ] An MCP search tool takes a natural-language query and returns the top matching chunks from Redis, using hybrid vector plus keyword search
- [ ] Exact-term queries (for example, a metric name or acronym) find the chunks that contain that term
- [ ] Each result includes the chunk text, its source file path, and its heading, so the agent can read the full entry if it needs more
- [ ] The number of results is configurable, with a sensible default

**4.4** As a **Domain Expert**, I want the search index to stay in sync with the knowledge files automatically, so that agents never search stale content.
- [ ] Saving an entry re-chunks and re-embeds it, and replaces that file's old chunks in Redis
- [ ] Deleting an entry removes its chunks
- [ ] An admin can rebuild the whole index from MinIO (for example, after changing the embedding model or chunking settings)

## Epic 5 — Agents propose, humans approve *(post-MVP)*

Each proposal is a unified diff (`git diff` format) stored next to the knowledge files. Patches are created and applied in Node.js with the `diff` npm package, so no git server is needed.

**5.1** As an **Agent**, I want to propose an update when I find context that is missing, outdated, or contradictory, so that the knowledge base gets better over time.
- [x] MCP tools let an agent propose page edits (exact find-and-replace) and new pages, each with its reasoning
- [x] Each proposal is saved as `proposals/<id>.patch`, with the agent's reasoning and the target page's version ID stored alongside it
- [x] A proposal **never** changes a knowledge file directly
- [x] Agents can also propose ontology concepts, aliases, and relationships with verified quotes; these join the Ontology review queue
- [x] Agents can check what happened to their proposals, including reviewers' notes; each user has at most 25 pending

**5.2** As a **Domain Expert**, I want to review agent proposals and approve, edit, or reject them, so that humans stay in control of what counts as true.
- [x] Pending proposals appear in a review queue (with a count in the sidebar and a banner on affected pages)
- [x] Each proposal shows a rendered diff and the agent's reasoning
- [x] I can approve (apply the patch and write the file), edit before approving, or reject with a note
- [x] If the target page has changed since the patch was created, the proposal is flagged as stale: shown against the current version if it still applies, and blocked from approval as-is if it doesn't
- [x] Once applied, changes are visible to agents and humans

**5.3** As a **Domain Expert**, I want to see the history of changes and who approved each one, so that I can trust and audit the knowledge base.
- [x] Each entry shows its version history from MinIO bucket versioning, including applied agent proposals, restores, moves, and deletions
- [x] Any earlier version can be viewed (changes and full content) and restored as the newest version, including for deleted pages
- [x] Every version records who wrote it, stored as object metadata; versions from proposals also record the proposal and who proposed it

## Epic 6 — Low maintenance

**6.1** As a **Domain Expert**, I want keeping knowledge current to take little effort, so that pont doesn't become another stale wiki.
- [ ] Agent proposals handle most of the upkeep; humans mainly review
- [ ] The review flow is fast enough to clear in a few minutes

> Main reasons a user would drop pont after a week: **heavy maintenance**, an **interface that's hard to understand**, and **MCP tools that aren't helpful**. Every story above should be judged against these three.


## Epic 7 — Documentation trivia *(post-MVP)*

Keeps people engaged with the documentation, and turns spotting stale content into a habit.

**7.1** As a **Domain Expert**, I want to answer multiple-choice questions generated from our documentation, so that I learn what's documented and notice when something is wrong.
- [x] Questions are written on the fly by an LLM from a random documentation chunk, with four options and one correct answer
- [x] The correct answer stays on the server until the question is answered; each question can be answered once
- [x] +1 for a correct answer, −1 for a wrong one; skipping scores nothing

**7.2** As a **Domain Expert**, I want a leaderboard, so that keeping up with the docs is a friendly competition.
- [x] All-time and weekly (Monday-based) leaderboards

**7.3** As a **Domain Expert**, I want a "Fact check" button on each question, so that I can fix the documentation as soon as I notice it's wrong.
- [x] Opens the source page scrolled to the section the question came from, with a prompt to edit it (no points)

**7.4** As an **AI Engineer**, I want to choose the LLM provider, so that trivia works with our existing model access.
- [x] Anthropic (official SDK) or any OpenAI-compatible endpoint, configured once on a Settings page
- [x] The API key is encrypted at rest and never returned to the browser


## Epic 8 — Ontology *(post-MVP)*

Turns free-text documentation into explicit concepts and relationships that people and agents can rely on, with AI doing the reading and people deciding what's true.

**8.1** As a **Domain Expert**, I want to calculate the ontology on demand, so that I control when LLM costs are incurred.
- [x] A **Calculate** button on the Ontology page, with a confirmation that lists the changed pages and estimates tokens and cost
- [x] Only pages added, changed, or deleted since the last calculation are analysed (snapshots of each page's state)

**8.2** As a **Domain Expert**, I want agents to keep the existing ontology accurate as pages change, so that it doesn't go stale.
- [x] A *maintain* workflow (Strands agent) recommends updates and deletions for concepts and relationships drawn from changed or deleted pages

**8.3** As a **Domain Expert**, I want agents to find new concepts and relationships, so that the ontology grows with the documentation.
- [x] A *create* workflow (Strands agent) recommends new concepts, aliases, and relationships, checking the existing ontology to avoid duplicates

**8.4** As a **Domain Expert**, I want to approve or reject every recommendation, so that the ontology only contains what we agree is true.
- [x] Every recommendation quotes its evidence, verified against the page
- [x] Approval applies it to `ontology.yaml`; rejection is remembered so it isn't suggested again

**8.5** As a **Domain Expert**, I want a page for every concept and relationship that I can edit or delete, so that I can correct the ontology directly.
- [x] Concept and relationship pages with edit, delete (warning when pages link to it), and adding relationships
- [x] Relationships can have a name and description
- [x] Each page lists the documentation that links to it

**8.6** As a **Domain Expert**, I want to link words in the documentation to ontology concepts, so that readers and agents know exactly what a term means.
- [x] Typing `[[` or pressing ⌘⇧K opens a picker of matching concepts and relationships (name, type, description), with "create concept" when nothing fits
- [x] Links are plain Markdown (`#/concept/<id>`), and agents can resolve them with the `get_concept` MCP tool
---

## Open questions

None right now. Add new questions here as they come up during implementation.
