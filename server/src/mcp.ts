import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { EntryError, getEntry, listEntries, parsePath } from './entries.js';
import { authenticateToken } from './tokens.js';
import { search, SearchUnavailableError } from './search/search.js';
import type { User } from './auth.js';

const INSTRUCTIONS = `pont holds this organization's knowledge, written by the people who know it:
business definitions and metrics, decisions and their reasoning, and processes.
Check pont before assuming how this organization works. Start with search,
which finds relevant passages by meaning and by exact terms; then read_entry to
read a whole entry. list_entries shows everything that exists, optionally
within a folder.`;

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], isError };
}

function errorText(err: unknown) {
  if (err instanceof EntryError) return text(err.message, true);
  throw err;
}

// One MCP server per request (stateless mode), bound to the token's user.
// The user isn't used by the read-only tools yet; it is here for attribution
// once agents can propose changes.
function buildServer(_user: User): McpServer {
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
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const results = await search(query, limit ?? 8);
        if (results.length === 0) return text(`No entries match "${query}".`);
        const blocks = results.map((r, i) => {
          const where = r.headings ? `${r.path} › ${r.headings}` : r.path;
          return `[${i + 1}] ${where}\n${r.content}`;
        });
        const count = results.length === 1 ? '1 passage' : `${results.length} passages`;
        return text(`${count} for "${query}":\n\n${blocks.join('\n\n---\n\n')}`);
      } catch (err) {
        if (err instanceof SearchUnavailableError) return text(err.message, true);
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
        'Use a path from list_entries, for example "processes/onboarding".',
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

  return server;
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
