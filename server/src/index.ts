import express from 'express';
import { config } from './config.js';
import { redis, db } from './clients.js';
import { checkHealth } from './health.js';
import { requireUser } from './auth.js';
import { entriesRouter, entryErrors } from './routes/entries.js';
import { tokensRouter } from './routes/tokens.js';
import { mcpRouter } from './mcp.js';
import { migrate } from './migrate.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { triviaRouter, triviaErrors } from './routes/trivia.js';
import { uploadsRouter, uploadErrors } from './routes/uploads.js';
import { ontologyRouter, ontologyErrors } from './routes/ontology.js';
import { proposalsRouter, proposalErrors } from './routes/proposals.js';
import { failInterruptedRuns } from './ontology/runs.js';
import { startIndexer } from './search/index.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Public routes: Docker health checks and the frontend's login bootstrap.
app.get('/api/health', async (_req, res) => {
  const health = await checkHealth();
  res.status(health.ok ? 200 : 503).json(health);
});

app.get('/api/config', (_req, res) => {
  const { publicUrl, realm, clientId } = config.keycloak;
  res.json({ keycloak: { url: publicUrl, realm, clientId } });
});

// MCP endpoint for agents. Authenticated by personal API token, not by a
// Keycloak login, so it sits outside the /api login check.
app.use('/mcp', mcpRouter);

// Everything registered below this line requires a logged-in user.
app.use('/api', requireUser);

app.get('/api/me', (req, res) => {
  res.json(req.user);
});

app.use('/api/entries', entriesRouter, entryErrors);
app.use('/api/tokens', tokensRouter);
app.use('/api/search', searchRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/trivia', triviaRouter, triviaErrors);
app.use('/api/uploads', uploadsRouter, uploadErrors);
app.use('/api/ontology', ontologyRouter, ontologyErrors);
app.use('/api/proposals', proposalsRouter, proposalErrors);

await redis.connect();
await migrate();
await failInterruptedRuns();

const server = app.listen(config.port, () => {
  console.log(`pont server listening on port ${config.port}`);
});

// Loads the embedding model and builds or catches up the search index in the
// background; search answers 503 until it is ready.
void startIndexer();

async function shutdown() {
  server.close();
  await Promise.allSettled([redis.quit(), db.end()]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
