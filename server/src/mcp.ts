import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { EntryError, getEntry, listEntries, parsePath } from './entries.js';
import { authenticateToken } from './tokens.js';
import { search, SearchUnavailableError } from './search/search.js';
import type { User } from './auth.js';
import { listProposals, proposeEdit, proposeNewPage, ProposalError } from './proposals/store.js';
import { verifyEvidence } from './ontology/evidence.js';
import { saveRecommendation, type Recommendation } from './ontology/recommendations.js';
import { CONCEPT_TYPES, findConcept, readOntology, RELATION_TYPES, type Concept } from './ontology/store.js';
import { conceptDetail, relationDetail, relationLabel } from './ontology/edit.js';
import { MAX_DEPTH, neighbourhood, shortestPath } from './ontology/traverse.js';
import { fromRef, inZone, listZones, parseZone, toRef, ZoneError, zoneName, zoneOf } from './ontology/zones.js';

const INSTRUCTIONS = `pont holds this organization's knowledge, written by the people who know it:
business definitions and metrics, decisions and their reasoning, and processes.
Check pont before assuming how this organization works. Start with search,
which finds relevant passages by meaning and by exact terms; then read_entry to
read a whole entry. list_entries shows everything that exists, optionally
within a folder.

The ontology is split into zones. The General zone ("") is the
organization-wide ontology, drawn from every page. Each top-level folder is
also a zone with its own ontology, drawn from that folder's pages only, so the
same term can mean different things in different folders. Pages may link terms
to the ontology, e.g. [WAU](#/concept/weekly-active-users) (General) or
[Revenue](#/concept/sales/revenue) (the "sales" zone), or [..](#/relation/<id>):
use get_concept with the link target for a concept's definition, aliases,
relationships, and the pages that link to it. list_concepts lists them.
explore_concept walks the graph around a concept (up to 3 hops) and
find_path shows how two concepts are connected.

If you find something missing, outdated, or contradictory, you can propose a
fix: propose_edit or propose_new_page for pages, and propose_concept,
propose_alias, or propose_relation for the ontology. Proposals never change
anything directly; a person reviews each one. Explain your reason and keep
edits small and focused. list_my_proposals shows what happened to them.`;

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], isError };
}

function errorText(err: unknown) {
  if (err instanceof EntryError || err instanceof ProposalError) return text(err.message, true);
  throw err;
}

const REVIEW_NOTE = 'It is now waiting for a person to review it; nothing has changed yet.';

// One MCP server per request (stateless mode), bound to the token's user:
// everything an agent proposes is attributed to that user.
function buildServer(user: User): McpServer {
  const server = new McpServer(
    { name: 'pont', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'search',
    {
      title: 'Search knowledge',
      description:
        'Searches all knowledge entries and returns the most relevant passages, best first. ' +
        'Matches by meaning (ask in plain language) and by exact terms such as metric names, ' +
        'acronyms, or system names. Each result names its entry path and section; use read_entry ' +
        'with that path for the full entry.',
      inputSchema: {
        query: z.string().min(1).describe('What you want to know, for example "how do we define an active user"'),
        limit: z.number().int().min(1).max(20).optional().describe('Maximum passages to return (default 8)'),
        zone: z.string().optional().describe('Only search this zone (a top-level folder, for example "sales")'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, zone }) => {
      try {
        const results = await search(query, limit ?? 8, zone ? inZone(parseZone(zone)) : undefined);
        if (results.length === 0) return text(`No entries match "${query}".`);
        const blocks = results.map((r, i) => {
          const where = r.headings ? `${r.path} › ${r.headings}` : r.path;
          return `[${i + 1}] ${where}\n${r.content}`;
        });
        const count = results.length === 1 ? '1 passage' : `${results.length} passages`;
        return text(`${count} for "${query}":\n\n${blocks.join('\n\n---\n\n')}`);
      } catch (err) {
        if (err instanceof SearchUnavailableError || err instanceof ZoneError) return text(err.message, true);
        throw err;
      }
    },
  );

  server.registerTool(
    'list_entries',
    {
      title: 'List knowledge entries',
      description:
        'Lists the paths of knowledge entries in pont, with when each was last updated. ' +
        'Paths look like "processes/onboarding". Pass a folder to list only the entries inside it.',
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Only list entries inside this folder, for example "processes"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ folder }) => {
      try {
        const prefix = folder?.trim().replace(/\/+$/, '');
        const scope = prefix ? `${parsePath(prefix)}/` : '';
        const entries = (await listEntries()).filter((e) => e.path.startsWith(scope));
        if (entries.length === 0) {
          return text(scope ? `No entries in folder "${prefix}".` : 'pont has no entries yet.');
        }
        const lines = entries.map((e) => `- ${e.path} (updated ${e.lastModified ?? 'unknown'})`);
        const count = entries.length === 1 ? '1 entry' : `${entries.length} entries`;
        return text(`${count}:\n${lines.join('\n')}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'read_entry',
    {
      title: 'Read a knowledge entry',
      description:
        'Returns the full Markdown of one knowledge entry, plus who last edited it and when. ' +
        'Use a path from list_entries, for example "processes/onboarding". Links in entries point to ' +
        'other entries as (#/p/<path>) or (#/p/<path>?section=<heading>), which read_entry can open, ' +
        'and to ontology concepts as (#/concept/<id>), which get_concept can look up.',
      inputSchema: {
        path: z.string().describe('Entry path without the .md extension, for example "processes/onboarding"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const entry = await getEntry(parsePath(path));
        const edited = [
          entry.author && `by ${entry.author.name}`,
          entry.lastModified && `on ${entry.lastModified}`,
        ]
          .filter(Boolean)
          .join(' ');
        return text(`Path: ${entry.path}\nLast edited ${edited}\n\n${entry.content}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  registerOntologyTools(server);
  registerProposalTools(server, user);
  return server;
}

const zoneLabel = (zone: string) => (zone ? `zone "${zone}"` : 'General zone');

function registerOntologyTools(server: McpServer) {
  const zoneParam = z
    .string()
    .optional()
    .describe('The zone (top-level folder, for example "sales"); "" for General, the organization-wide ontology. Omit to look in every zone.');

  server.registerTool(
    'get_concept',
    {
      title: 'Get an ontology concept or relationship',
      description:
        'Returns a concept (by id, name, or alias) with its zone, type, definition, aliases, relationships, and the pages ' +
        'that link to it. Also accepts a link target such as "sales/revenue" from #/concept/sales/revenue, or a ' +
        'relationship id from a #/relation/<id> link. Without a zone, every zone is searched and all matches are returned.',
      inputSchema: { concept: z.string().describe('Concept id, name, or alias; or a relationship id'), zone: zoneParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ concept, zone }) => {
      // Where to look, as [zone, id or name] pairs: the given zone; a link
      // target's zone; or every zone (also when a name with a "/" in it
      // turns out not to be a link target).
      const wanted = concept.trim();
      let lookups: [string, string][];
      try {
        const everyZone = async () => (await listZones()).map((z): [string, string] => [z.zone, wanted]);
        if (zone !== undefined) lookups = [[parseZone(zone), wanted]];
        else if (wanted.includes('/')) {
          const parsed = fromRef(wanted);
          lookups = [[parsed.zone, parsed.id], ...(await everyZone())];
        } else lookups = await everyZone();
      } catch (err) {
        if (err instanceof ZoneError) return text(err.message, true);
        throw err;
      }
      const found: string[] = [];
      const seen = new Set<string>();
      for (const [z, ref] of lookups) {
        // A link target that resolved needs no search by name.
        if (found.length && ref === wanted && lookups[0][1] !== wanted) break;
        const { ontology } = await readOntology(z);
        const c = findConcept(ontology, ref);
        if (c) {
          if (seen.has(toRef(z, c.id))) continue;
          seen.add(toRef(z, c.id));
          const d = await conceptDetail(z, c.id);
          found.push(
            [
              `${d.name} (${d.type}, ${zoneLabel(z)}, link target ${toRef(z, d.id)})`,
              d.aliases.length ? `Also called: ${d.aliases.join(', ')}` : '',
              d.definition ? `Definition: ${d.definition}` : '',
              d.relations.length ? `Relationships:\n${d.relations.map((r) => `- ${r.label} [${r.id}]${r.description ? `: ${r.description}` : ''}`).join('\n')}` : '',
              d.linkedFrom.length ? `Linked from pages: ${d.linkedFrom.join(', ')}` : '',
              d.sources.length ? `Sources: ${[...new Set(d.sources.map((s) => s.path))].join(', ')}` : '',
            ].filter(Boolean).join('\n'),
          );
        } else if (ontology.relations.some((r) => r.id === ref) && !seen.has(toRef(z, ref))) {
          seen.add(toRef(z, ref));
          const r = await relationDetail(z, ref);
          found.push(
            [
              `${r.label} (relationship, ${zoneLabel(z)}, link target ${toRef(z, r.id)})`,
              `${r.fromConcept?.name ?? r.from} ${r.type.replace(/_/g, ' ')} ${r.toConcept?.name ?? r.to}`,
              r.description ? `Description: ${r.description}` : '',
              r.linkedFrom.length ? `Linked from pages: ${r.linkedFrom.join(', ')}` : '',
            ].filter(Boolean).join('\n'),
          );
        }
      }
      if (!found.length) return text(`No concept or relationship "${concept}". Try list_concepts.`, true);
      return text(found.join('\n\n---\n\n'));
    },
  );

  server.registerTool(
    'list_concepts',
    {
      title: 'List ontology concepts',
      description:
        'Lists the concepts (id, name, type, aliases) and relationships in a zone\'s ontology, or in every zone when no zone is given.',
      inputSchema: { zone: zoneParam },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ zone }) => {
      let zones: string[];
      try {
        zones = zone !== undefined ? [parseZone(zone)] : (await listZones()).map((z) => z.zone);
      } catch (err) {
        if (err instanceof ZoneError) return text(err.message, true);
        throw err;
      }
      const sections: string[] = [];
      for (const z of zones) {
        const { ontology } = await readOntology(z);
        if (!ontology.concepts.length) continue;
        const concepts = ontology.concepts.map(
          (c) => `- ${c.name} (${c.type}, id ${c.id})${c.aliases.length ? `, also ${c.aliases.join(', ')}` : ''}`,
        );
        const relations = ontology.relations.map((r) => `- ${relationLabel(ontology, r)} [${r.id}]`);
        const head = zones.length > 1 ? `## ${zoneName(z)} (${zoneLabel(z)})\n\n` : '';
        sections.push(`${head}Concepts:\n${concepts.join('\n')}${relations.length ? `\n\nRelationships:\n${relations.join('\n')}` : ''}`);
      }
      if (!sections.length) return text(zones.length === 1 ? `The ${zoneLabel(zones[0])} has no concepts yet.` : 'The ontology is empty.');
      return text(sections.join('\n\n'));
    },
  );

  // A concept named the way get_concept accepts it: a link target
  // ("sales/revenue"), or an id, name, or alias in the given zone or any zone.
  async function resolve(concept: string, zone: string | undefined): Promise<{ zone: string; id: string; name: string }[]> {
    const wanted = concept.trim();
    const lookups: [string, string][] =
      zone !== undefined
        ? [[parseZone(zone), wanted]]
        : wanted.includes('/') && (await readOntology(fromRef(wanted).zone)).ontology.concepts.some((c) => c.id === fromRef(wanted).id)
          ? [[fromRef(wanted).zone, fromRef(wanted).id]]
          : (await listZones()).map((z): [string, string] => [z.zone, wanted]);
    const found: { zone: string; id: string; name: string }[] = [];
    for (const [z, ref] of lookups) {
      const c = findConcept((await readOntology(z)).ontology, ref);
      if (c) found.push({ zone: z, id: c.id, name: c.name });
    }
    return found;
  }

  const ambiguous = (concept: string, matches: { zone: string }[]) =>
    text(
      `"${concept}" is a concept in several zones: ${matches.map((m) => zoneLabel(m.zone)).join(', ')}. Pass "zone" to pick one.`,
      true,
    );

  server.registerTool(
    'explore_concept',
    {
      title: 'Explore the ontology graph around a concept',
      description:
        'Walks the ontology graph from a concept: the concepts within 1 to 3 relationship hops (with how far each is), ' +
        'the relationships between them, the pages that link to the concept, and the pages it was drawn from. ' +
        'Use it to understand how a term fits with the rest of the organization\'s vocabulary.',
      inputSchema: {
        concept: z.string().describe('Concept id, name, or alias, or a link target such as "sales/revenue"'),
        zone: zoneParam,
        depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe('How many relationship hops to follow (default 2)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ concept, zone, depth }) => {
      let matches;
      try {
        matches = await resolve(concept, zone);
      } catch (err) {
        if (err instanceof ZoneError) return text(err.message, true);
        throw err;
      }
      if (!matches.length) return text(`No concept "${concept}". Try list_concepts.`, true);
      if (matches.length > 1) return ambiguous(concept, matches);
      const m = matches[0];
      const n = await neighbourhood(m.zone, m.id, depth ?? 2);
      if (!n) return text(`No concept "${concept}".`, true);
      const names = new Map([[n.concept.id, n.concept.name], ...n.neighbours.map((x): [string, string] => [x.id, x.name])]);
      const byHops = new Map<number, string[]>();
      for (const x of n.neighbours) byHops.set(x.hops, [...(byHops.get(x.hops) ?? []), `${x.name} (${x.type}, link target ${toRef(m.zone, x.id)})`]);
      return text(
        [
          `${n.concept.name} (${n.concept.type}, ${zoneLabel(m.zone)}, link target ${toRef(m.zone, n.concept.id)})`,
          n.concept.definition ? `Definition: ${n.concept.definition}` : '',
          n.neighbours.length
            ? [...byHops.entries()].map(([h, list]) => `${h} ${h === 1 ? 'hop' : 'hops'} away:\n${list.map((l) => `- ${l}`).join('\n')}`).join('\n')
            : 'No related concepts.',
          n.relations.length
            ? `Relationships:\n${n.relations
                .map((r) => `- ${names.get(r.from) ?? r.from} ${r.type.replace(/_/g, ' ')} ${names.get(r.to) ?? r.to}${r.name ? ` ("${r.name}")` : ''} [${r.id}]`)
                .join('\n')}`
            : '',
          n.linkedFrom.length ? `Linked from pages: ${n.linkedFrom.join(', ')}` : '',
          n.sources.length ? `Drawn from pages: ${n.sources.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    },
  );

  server.registerTool(
    'find_path',
    {
      title: 'Find how two concepts are connected',
      description:
        'Finds the shortest chain of ontology relationships between two concepts in the same zone (following ' +
        'relationships in either direction), for questions like "how does X relate to Y?".',
      inputSchema: {
        from: z.string().describe('Concept id, name, or alias, or a link target'),
        to: z.string().describe('Concept id, name, or alias, or a link target'),
        zone: zoneParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ from, to, zone }) => {
      let a, b;
      try {
        [a, b] = await Promise.all([resolve(from, zone), resolve(to, zone)]);
      } catch (err) {
        if (err instanceof ZoneError) return text(err.message, true);
        throw err;
      }
      if (!a.length) return text(`No concept "${from}".`, true);
      if (!b.length) return text(`No concept "${to}".`, true);
      // Relationships stay inside a zone: pick the zone both are in.
      const pair = a.flatMap((x) => b.filter((y) => y.zone === x.zone).map((y) => [x, y] as const));
      if (!pair.length) {
        return text(`"${from}" and "${to}" are in different zones, and relationships don't cross zones.`, true);
      }
      if (pair.length > 1) return ambiguous(`${from}" and "${to}`, pair.map(([x]) => x));
      const [x, y] = pair[0];
      if (x.id === y.id) return text('Those are the same concept.', true);
      const steps = await shortestPath(x.zone, x.id, y.id);
      if (!steps) return text(`${x.name} and ${y.name} are not connected within 6 relationships in the ${zoneLabel(x.zone)}.`);
      return text(
        `${x.name} → ${y.name} in ${steps.length} ${steps.length === 1 ? 'step' : 'steps'} (${zoneLabel(x.zone)}):\n` +
          steps.map((st) => `- ${st.from} ${st.type.replace(/_/g, ' ')} ${st.to}${st.name ? ` ("${st.name}")` : ''}`).join('\n'),
      );
    },
  );
}

function registerProposalTools(server: McpServer, user: User) {
  const edit = z.object({
    find: z.string().describe('Exact text currently on the page (must match exactly once, including whitespace)'),
    replace: z.string().describe('What to put there instead (empty to delete it)'),
  });

  server.registerTool(
    'propose_edit',
    {
      title: 'Propose an edit to a page',
      description:
        'Proposes a change to an existing documentation page as one or more find-and-replace edits. ' +
        'Read the page with read_entry first and copy the "find" text exactly. A person reviews the ' +
        'proposal before anything changes.',
      inputSchema: {
        path: z.string().describe('Page path, for example "processes/onboarding"'),
        edits: z.array(edit).min(1).max(20),
        reason: z.string().describe('Why this change is needed, with any source you relied on'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, edits, reason }) => {
      try {
        const p = await proposeEdit(path, edits, reason, user);
        return text(`Proposed an edit to "${p.path}" (proposal ${p.id}). ${REVIEW_NOTE}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    'propose_new_page',
    {
      title: 'Propose a new page',
      description:
        'Proposes a new documentation page in Markdown. Search first to make sure it does not already exist. ' +
        'A person reviews the proposal before the page is created.',
      inputSchema: {
        path: z.string().describe('Path for the new page, for example "processes/incident-response"'),
        content: z.string().describe('The full Markdown of the page, starting with a "# Title" heading'),
        reason: z.string().describe('Why this page is needed'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, content, reason }) => {
      try {
        const p = await proposeNewPage(path, content, reason, user);
        return text(`Proposed a new page at "${p.path}" (proposal ${p.id}). ${REVIEW_NOTE}`);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // Ontology proposals join the Ontology page's review queue.
  const evidence = z
    .array(z.object({ path: z.string(), quote: z.string().describe('An exact passage from that page') }))
    .min(1)
    .describe('Exact quotes from documentation pages that support this');
  const rationale = z.string().describe('Why, in one or two sentences');
  const zoneParam = z
    .string()
    .optional()
    .describe(
      'The zone whose ontology this changes: a top-level folder, or "" for General (the organization-wide ontology, which may quote any page). ' +
        "Defaults to the evidence pages' folder, or General when they are in different folders.",
    );

  // An ontology proposal belongs to one zone: the one given; else the folder
  // zone all its evidence pages are in; else General, which covers every page.
  function proposalZone(zone: string | undefined, quotes: { path: string }[]): string {
    if (zone !== undefined) return parseZone(zone);
    const zones = new Set(quotes.map((q) => zoneOf(q.path.trim())));
    return zones.size === 1 ? [...zones][0] : '';
  }

  async function inZoneOntology<T>(
    zone: string | undefined,
    quotes: { path: string }[],
    then: (zone: string, find: (ref: string) => Promise<Concept | undefined>) => Promise<T>,
  ) {
    let z: string;
    try {
      z = proposalZone(zone, quotes);
    } catch (err) {
      if (err instanceof ZoneError) return text(`Not proposed: ${err.message}`, true);
      throw err;
    }
    return then(z, async (ref) => findConcept((await readOntology(z)).ontology, ref));
  }

  async function recommend(zone: string, recommendation: Recommendation, why: string, quotes: { path: string; quote: string }[]) {
    const problem = await verifyEvidence(quotes, undefined, zone);
    if (problem) return text(`Not proposed: ${problem}`, true);
    const outcome = await saveRecommendation({
      runId: null,
      zone,
      proposedBy: user.name ?? user.username,
      workflow: 'agent',
      recommendation,
      rationale: why,
      evidence: quotes,
      confidence: 1,
    });
    return text(
      {
        saved: `Proposed. ${REVIEW_NOTE}`,
        duplicate: 'The same change (or a concept with this name) is already waiting for review.',
        'previously-rejected': 'A person already rejected this exact change.',
      }[outcome],
      outcome !== 'saved',
    );
  }

  server.registerTool(
    'propose_concept',
    {
      title: 'Propose an ontology concept',
      description:
        'Proposes a new concept for the ontology (a metric, process, decision, policy, system, team, or term ' +
        'that the documentation defines). Quote the passage that defines it.',
      inputSchema: {
        name: z.string(),
        type: z.enum(CONCEPT_TYPES),
        definition: z.string().describe('One or two sentences, faithful to the documentation'),
        aliases: z.array(z.string()).default([]),
        rationale,
        evidence,
        zone: zoneParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, type, definition, aliases, rationale: why, evidence: quotes, zone }) =>
      inZoneOntology(zone, quotes, async (z, find) => {
        const existing = await find(name);
        if (existing) return text(`"${name}" already exists in the ${zoneLabel(z)} as concept "${existing.id}". Propose an alias instead.`, true);
        return recommend(z, { action: 'create_concept', payload: { name, type, definition, aliases } }, why, quotes);
      }),
  );

  server.registerTool(
    'propose_alias',
    {
      title: 'Propose an alias for a concept',
      description: 'Proposes another name (synonym, abbreviation) for an existing ontology concept.',
      inputSchema: { concept: z.string().describe('Concept id or name'), alias: z.string(), rationale, evidence, zone: zoneParam },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ concept, alias, rationale: why, evidence: quotes, zone }) =>
      inZoneOntology(zone, quotes, async (z, find) => {
        const c = await find(concept);
        if (!c) return text(`No concept "${concept}" in the ${zoneLabel(z)}.`, true);
        return recommend(z, { action: 'add_alias', payload: { conceptId: c.id, alias } }, why, quotes);
      }),
  );

  server.registerTool(
    'propose_relation',
    {
      title: 'Propose an ontology relationship',
      description: 'Proposes a typed relationship from one concept to another, as the documentation states it.',
      inputSchema: {
        from: z.string().describe('Concept id or name'),
        type: z.enum(RELATION_TYPES),
        to: z.string().describe('Concept id or name'),
        rationale,
        evidence,
        zone: zoneParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, type, to, rationale: why, evidence: quotes, zone }) => {
      if (from.trim().toLowerCase() === to.trim().toLowerCase()) return text('A concept cannot relate to itself.', true);
      return inZoneOntology(zone, quotes, (z) => recommend(z, { action: 'create_relation', payload: { from, type, to } }, why, quotes));
    },
  );

  server.registerTool(
    'list_my_proposals',
    {
      title: 'List my page proposals',
      description: 'Lists page proposals made with your token: pending ones, and recently reviewed ones with the outcome.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [pending, decided] = await Promise.all([
        listProposals('pending', user.id),
        listProposals('decided', user.id),
      ]);
      const line = (p: Awaited<ReturnType<typeof listProposals>>[number]) =>
        `- ${p.id} ${p.kind === 'new' ? 'new page' : 'edit'} "${p.path}": ${p.status}` +
        (p.decidedBy ? ` by ${p.decidedBy}` : '') +
        (p.decisionNote ? ` (${p.decisionNote})` : '');
      if (!pending.length && !decided.length) return text('You have no page proposals.');
      return text(
        [`Pending (${pending.length}):`, ...pending.map(line), `Reviewed (${decided.length}):`, ...decided.slice(0, 20).map(line)].join('\n'),
      );
    },
  );
}

function unauthorized(res: Response, message: string) {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer')
    .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

export const mcpRouter = Router();

mcpRouter.post('/', async (req: Request, res: Response) => {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) {
    unauthorized(res, 'Missing API token. Create one in pont under API tokens.');
    return;
  }
  const user = await authenticateToken(token);
  if (!user) {
    unauthorized(res, 'Invalid or revoked API token.');
    return;
  }

  const server = buildServer(user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless mode has no server-initiated streams or sessions to end.
mcpRouter.all('/', (_req, res) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
});
