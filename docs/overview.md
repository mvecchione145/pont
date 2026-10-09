# Product overview

## The problem

Every organization runs on knowledge that lives in people's heads: how a metric is calculated, why a decision was made, which team owns a system, what a piece of jargon means. AI agents need that knowledge too, and today it reaches them badly.

Tools for organizational knowledge fall into two camps, and each solves only half the problem:

- **Documentation tools** (wikis, shared drives, Notion, Confluence) are built for people to read and write. Agents can't use them well: there is no clean, permissioned way to search them by meaning, and nobody can see what an agent actually read.
- **Agent-context tools** (MCP servers, retrieval pipelines, agent memory) give agents context, but people can't easily see, curate, or trust what the agents are working from. Knowledge drifts, and an agent's "memory" is a black box.

Teams end up stitching tools together and still don't get a single source of truth that both sides use.

## What pont is

pont is **one system that both humans and agents use**, with people in charge of what counts as true:

```
 Humans ──── write, browse, curate ──────▶ ┌──────┐ ──── read context (MCP) ────▶ Agents
                                           │ pont │
 Humans ◀── review and approve/reject ──── └──────┘ ◀── propose updates (MCP) ─── Agents
```

- **People write** knowledge as plain Markdown pages in a Notion-style editor: business definitions, decisions and their reasons, processes, glossaries.
- **Agents read** it through MCP tools: hybrid search, reading whole pages, and looking up ontology concepts. Context is delivered on demand when an agent asks, never pushed into its sessions.
- **Agents propose** fixes when they find something missing, outdated, or contradictory, but **they can never change anything themselves.** Every proposal waits in a review queue for a person to approve, edit, or reject.
- **AI helps people keep it current**: an on-demand page review suggests clearer wording, finds contradictions with other pages, and links terms to the ontology. An ontology of concepts and relationships is built from the documentation and approved item by item. Trivia keeps people reading.

## How pont is different

| | Typical wiki | Typical agent memory / RAG | **pont** |
|---|---|---|---|
| Who writes the knowledge | People | The agent, or an automatic import | **People, on purpose** |
| How agents get it | Scraping or ad-hoc connectors | Retrieval or injection the user can't see | **MCP tools that return cited passages** |
| Can agents change it? | No | Yes, silently | **They propose; a person approves** |
| Can people see what agents see? | — | Rarely | **Yes: same pages, same search** |
| History and audit | Varies | Rarely | **Every version kept, with author and source** |
| Shared vocabulary | Free text only | Embeddings only | **An approved ontology, linked from the text** |
| Hosting | Usually SaaS | Usually SaaS | **Self-hosted with one `docker compose up`, open source** |

What that adds up to:

1. **Humans stay in control of truth.** Nothing an LLM or agent produces (page edits, new pages, ontology changes, review suggestions) takes effect without a person approving it. Every applied change records who wrote it, who proposed it, and where it came from.
2. **One source of truth for both sides.** A person searching pont and an agent calling the `search` tool get the same results from the same pages. If an answer is wrong, the fix is one edit, and both sides see it.
3. **Plain files, no lock-in.** Knowledge is stored as plain Markdown files in S3-compatible storage (MinIO), with every version kept. Links to the ontology are ordinary Markdown links. You can read, back up, or move the files with any tool.
4. **Low maintenance by design.** Keeping docs current is where knowledge bases die. pont turns upkeep into review: agents propose, the page review points out unclear and conflicting text, and trivia makes stale content visible. People mostly click **Approve**.
5. **Cost you can see.** Every feature that calls a paid LLM (ontology calculation, page review) shows an estimate first and runs only when a person starts it. Search runs on a local embedding model and costs nothing per query.
6. **Small and self-hosted.** Six containers, no external services required beyond an optional LLM API. It works offline except for the LLM features.

## Who it's for

| Persona | What they need from pont |
|---|---|
| **Domain expert** (primary): anyone who knows how the business, a process, or a decision works | A simple place to capture what they know, and confidence that agents use it correctly |
| **AI engineer**: builds agents and connects them to tools | MCP tools that reliably return the right context with little setup |
| **Agent**: an AI agent connected through MCP | Findable, structured, cited context, and a channel to report gaps |

## What "context" means in pont

Any knowledge specific to your organization, for example:

- **Business intelligence:** metrics, definitions, how the business works
- **Decisions:** what was decided, why, and by whom
- **Processes:** how things get done here
- **Vocabulary:** the systems, teams, and terms people use, and how they relate (the ontology)

## Features at a glance

- Notion-style Markdown editor with folders, autosave, and conflict protection
- File and folder upload (Markdown, text, Word, HTML, PDF)
- Hybrid search (meaning plus exact terms), for people (⌘K) and agents (MCP)
- Page history with diffs and one-click restore, including deleted pages
- Personal API tokens and an MCP endpoint for Claude Code and other MCP clients
- Agent proposals for page edits, new pages, and ontology changes, with a review queue
- Page review: clarity suggestions, conflicts with other pages, and missing ontology links
- Ontology: concepts and relationships built by agents on demand, approved by people, linkable from any page
- Documentation trivia with weekly and all-time leaderboards, and a "fact check" shortcut to fix what's wrong

## What pont is not (yet)

- **Not a permissions system.** Everyone who can sign in can read and edit everything; there are no roles.
- **Not an importer.** Knowledge is written or uploaded on purpose; nothing is pulled from chat, tickets, or other tools automatically.
- **Not hardened for the internet.** Defaults are for local or trusted-network use. Change every password, and put it behind TLS, before exposing it.
- **Not single sign-on with your identity provider** yet. Accounts are managed in pont's own Keycloak.
