# Using pont

This guide walks through pont from first start to everyday use, with examples. The examples use a fictional company that runs ads on screens at gas stations; swap in your own knowledge.

- [1. Start pont](#1-start-pont)
- [2. Create accounts](#2-create-accounts)
- [3. Write knowledge](#3-write-knowledge)
- [4. Find knowledge](#4-find-knowledge)
- [5. Connect Claude Code](#5-connect-claude-code)
- [6. Review what agents propose](#6-review-what-agents-propose)
- [7. Review a page with AI](#7-review-a-page-with-ai)
- [8. Build the ontology](#8-build-the-ontology)
- [9. Play trivia](#9-play-trivia)
- [10. History and restore](#10-history-and-restore)

## 1. Start pont

You need Docker with Compose v2 and about 5 GB of free disk (see [disk space](technical.md#disk-space)).

```sh
git clone <your pont repository> pont && cd pont
docker compose up -d --wait
```

The first start takes a minute or two while images download and Keycloak initializes. Then open **http://localhost:3000**.

Before running pont anywhere other than your own machine, copy `.env.example` to `.env` and change every password, and set `PONT_SECRET_KEY`:

```sh
cp .env.example .env
openssl rand -base64 32   # paste the result as PONT_SECRET_KEY in .env
docker compose up -d --wait
```

Check that everything is healthy:

```sh
curl http://localhost:3000/api/health
```

## 2. Create accounts

pont has no self-signup; an admin creates each account in Keycloak.

1. Open http://localhost:8080/admin and sign in as the bootstrap admin (`admin` / `admin` by default).
2. Switch to the **pont** realm.
3. **Users → Create user**: enter a username and email.
4. On the **Credentials** tab, set a password. Leave **Temporary** on so the person picks their own at first sign-in.

Everyone who can sign in can read and edit everything.

## 3. Write knowledge

Click **＋ New page** (or the **＋** next to *Pages*) and type. Changes save automatically.

- **Name the page** in the title at the top. Use `/` in the folder field (⋯ → **Move to folder…**) to organize pages, for example `metrics/weekly-active-screens`.
- Type **`/`** for the block menu: headings, lists, to-dos, quotes, code, tables, and **Advanced → Link to page or concept**.
- **Select text** for the formatting toolbar: bold, italic, strikethrough, code, link, and **Link to page, heading, or concept**.
- If someone else saves the same page while you're editing, pont won't overwrite their version. It offers to copy your text or load theirs.

An example page, `metrics/weekly-active-screens`:

```markdown
# Weekly active screens

A screen is **active** in a week when it reports at least one proof-of-play
record between Monday 00:00 and Sunday 23:59 UTC.

## Owner

The Data team owns this metric. Questions go to #data-help.

## Decision log

- 2026-03-02: Switched from "any heartbeat" to "any proof-of-play record",
  because heartbeats kept arriving from screens that were powered on but blank.
  Decided by the Data team with Sales.
```

### Linking pages and headings

Type `[[` and a few letters to link to another page, a heading, or an ontology concept. Add `#` to link to a heading:

| You type | Links to | Saved as |
|---|---|---|
| `[[onboarding` | The page `processes/onboarding` | `[onboarding](#/p/processes/onboarding)` |
| `[[#escal` | The *Escalation* heading on this page | `[Escalation](#/p/<this page>?section=Escalation)` |
| `[[onboarding#escal` | The *Escalation* heading on the onboarding page | `[Escalation](#/p/processes/onboarding?section=Escalation)` |

Links break when a page is moved, renamed, or deleted, a heading is renamed, or a concept is deleted. **Link check** in the sidebar lists every dead link in the workspace, and the **✦ Review** panel shows the current page's dead links as soon as it opens (no LLM needed). Each one suggests where it should point now when pont can tell (for example, where the page was moved), with **Point to …** to repoint every link to that destination on the page, or **Unlink** to keep the text.

You can also select text and press **⌘⇧K** or use the toolbar button to turn it into a link. **⌘-click** (Ctrl-click) a link to follow it: a heading link opens the page scrolled to that heading and highlights it. Agents see the same links when they read a page and can follow them with `read_entry`.

Plain Markdown is all there is: no templates or required fields. A decision is captured by writing down what was decided, why, and by whom.

### Uploading existing documents

Click **Upload** and drop files or whole folders. A preview shows where each file will go before anything is written.

| You upload | You get |
|---|---|
| `Handbook/Eng/On-call.md` into the folder `docs` | The page `docs/Handbook/Eng/On-call` |
| `Pricing.docx` | Markdown with headings, lists, links, and tables (images are dropped) |
| `Policy.pdf` | The text only (scanned PDFs have no text to import) |

Pages that already exist are skipped unless you tick **Replace existing**; replaced pages keep their old versions in history.

## 4. Find knowledge

Press **⌘K** (Ctrl K) and type a question or a term:

| You type | pont finds |
|---|---|
| `how do we count an active screen` | The *Weekly active screens* definition, by meaning, even though the words differ |
| `POP` | Passages that contain the acronym itself |
| `who owns weekly active screens` | The *Owner* section of that page |

Results show the page and section; click one to open it. Unrelated questions return nothing rather than a list of weak matches.

## 5. Connect Claude Code

1. In pont, open **API tokens** and create a token. It's shown once, with the command to run.
2. Run the command:

   ```sh
   claude mcp add --transport http pont http://localhost:3000/mcp \
     --header "Authorization: Bearer pont_..."
   ```

3. Ask Claude Code something your docs answer:

   > How do we define a weekly active screen? Check pont.

Claude Code calls pont's tools as you. A typical exchange:

```text
→ search { "query": "definition of weekly active screen" }
← 2 passages for "definition of weekly active screen":

  [1] metrics/weekly-active-screens › Weekly active screens
  A screen is **active** in a week when it reports at least one proof-of-play
  record between Monday 00:00 and Sunday 23:59 UTC.
  ---
  [2] metrics/weekly-active-screens › Weekly active screens › Decision log
  - 2026-03-02: Switched from "any heartbeat" to "any proof-of-play record", ...

→ get_concept { "concept": "Proof of Play" }
← Proof of Play (Term, id proof-of-play)
  Also called: POP
  Definition: A record confirming a given piece of media actually played on a
  given device; the basis for programmatic billing and campaign reporting.
  Relationships:
  - Weekly active screens calculated from Proof of Play [...]
  Linked from pages: metrics/weekly-active-screens
```

### The MCP tools

| Tool | What it does | Example input |
|---|---|---|
| `search` | Hybrid search; returns cited passages, best first | `{ "query": "who owns the playlist service", "limit": 5 }` |
| `list_entries` | Lists page paths, optionally in one folder | `{ "folder": "metrics" }` |
| `read_entry` | Returns a whole page, with who edited it last | `{ "path": "metrics/weekly-active-screens" }` |
| `get_concept` | Looks up an ontology concept or relationship by id, name, or alias | `{ "concept": "POP" }` |
| `list_concepts` | Lists every concept and relationship | `{}` |
| `propose_edit` | Proposes find-and-replace edits to a page | see below |
| `propose_new_page` | Proposes a new page | `{ "path": "processes/screen-outage", "content": "# Screen outage\n...", "reason": "..." }` |
| `propose_concept` | Proposes an ontology concept, with quoted evidence | see below |
| `propose_alias` | Proposes another name for a concept | `{ "concept": "Proof of Play", "alias": "PoP record", "rationale": "...", "evidence": [...] }` |
| `propose_relation` | Proposes a relationship between two concepts | `{ "from": "Weekly active screens", "type": "calculated_from", "to": "Proof of Play", ... }` |
| `list_my_proposals` | Shows what happened to your proposals, with reviewers' notes | `{}` |

An agent that notices an outdated owner proposes a fix like this. Each `find` must match the page exactly once:

```json
{
  "path": "metrics/weekly-active-screens",
  "edits": [
    { "find": "The Data team owns this metric.", "replace": "The Analytics team owns this metric." }
  ],
  "reason": "The 2026 org chart page says Data became Analytics in May."
}
```

And a new concept must quote the pages that support it:

```json
{
  "name": "Weekly active screens",
  "type": "Metric",
  "definition": "Screens that report at least one proof-of-play record in a Monday-to-Sunday UTC week.",
  "aliases": ["WAS"],
  "rationale": "Defined on its own page and used in the quarterly report.",
  "evidence": [
    { "path": "metrics/weekly-active-screens", "quote": "A screen is **active** in a week when it reports at least one proof-of-play" }
  ]
}
```

Concept types are `Metric`, `Process`, `Decision`, `Policy`, `System`, `Team`, and `Term`. Relationship types are `calculated_from`, `depends_on`, `part_of`, `owned_by`, `uses`, and `related_to`.

> **Tip:** add a line to your project's `CLAUDE.md` such as *"Before answering questions about how the business works, search pont. If pont is wrong or missing something, propose a fix."* so agents use it without being asked.

## 6. Review what agents propose

Agents never change anything directly. Their proposals wait for you:

- **Page proposals** appear on **Proposals** (with a count in the sidebar and a banner on the affected page). Each shows the agent's reason and a diff. **Approve**, **Edit and approve**, or **Reject** with a note the agent can read through `list_my_proposals`.
- If the page changed since the agent looked, the proposal is marked stale: you see it against the current version if it still applies, and must edit it in by hand if it doesn't.
- **Ontology proposals** join the review queue on the **Ontology** page (see [section 8](#8-build-the-ontology)).

Each user can have at most 25 page proposals waiting.

## 7. Review a page with AI

Click **✦ Review** at the top right of any page. The review needs an LLM configured in **Settings** (see [section 9](#9-play-trivia)).

1. pont saves your edits, finds the most related passages on other pages, and shows what it will send and the estimated cost, for example *"~4k input + ~6k output tokens · $0.07 – $0.27"*.
2. Click **Yes, review**. The review usually takes under a minute.
3. The panel lists three kinds of findings:

| Finding | Example | What you can do |
|---|---|---|
| **Conflicts** with other pages | This page says Webslinger uploads files *only to Xibo*; the glossary says it uploads them *to the PosMM Central Repository and to ICS* | Open the other page, **Apply** the suggested fix when this page is the wrong one, or **Dismiss** |
| **Missing links** to the ontology | "APPY" is mentioned but not linked to the *APPY* concept | **Add link** turns it into `[APPY](#/concept/appy)` |
| **Suggestions** for clarity | "It handles media." → "Webslinger converts and uploads media files." | **Apply**, **Show** it in the editor, or **Dismiss** |

Applying a finding saves a new page version, marked *From a review* in the history. Nothing changes until you click. The panel also lists the page's **dead links** at the top, before you run a review (see [Linking pages and headings](#linking-pages-and-headings)).

## 8. Build the ontology

The ontology is the shared vocabulary of your documentation: concepts (metrics, processes, decisions, policies, systems, teams, terms) and how they relate.

1. Open **Ontology** and click **Calculate**. pont lists the pages added, changed, or deleted since the last calculation, with an estimated cost. Confirm to start.
2. Two agents run: one recommends updates and deletions for the existing ontology, the other recommends new concepts, aliases, and relationships. Every recommendation quotes the page that supports it.
3. Review the recommendations: **Approve** or **Reject** each one, or use **Approve all** / **Reject all** for the whole queue or a group. Approvals run in a safe order (new concepts before the relationships that need them).

Every concept and relationship has its own page where you can edit it, delete it, add relationships, and see which pages link to it.

**Linking text to a concept** works four ways in the editor: type `[[` and a few letters; select text and press **⌘⇧K**; select text and click the link button at the end of the toolbar; or type `/` and choose **Advanced → Link to page or concept**. The same picker lists pages and headings too, and can create a new concept on the spot.

## 9. Play trivia

**Trivia** asks a multiple-choice question written on the fly from a random section of your docs. A correct answer scores +1 and a wrong one −1, with weekly (from Monday) and all-time leaderboards.

After each question, **Fact check this section** opens the source page at that section, so you can fix anything that's out of date right away.

Trivia, page review, and the ontology need an LLM. Set it up once under **Settings**:

| Provider | Model | Base URL |
|---|---|---|
| Anthropic | `claude-opus-5-5` (default) | leave empty |
| OpenAI | e.g. `gpt-5` | leave empty |
| Ollama on your machine | e.g. `llama3.3` | `http://host.docker.internal:11434/v1` |

The API key is encrypted with `PONT_SECRET_KEY` and never sent back to the browser.

## 10. History and restore

Every save is a new version; nothing is ever overwritten. Open **⋯ → Page history** on any page to see each version, who wrote it, where it came from (an edit, an agent proposal, a review, a restore, or a move), and what it changed. **Restore this version** saves that content as the newest version.

Deleted pages keep their history at `#/history/<page path>`, and restoring a version brings the page back.
