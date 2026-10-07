import express from 'express';
import { config } from './config.js';
import { redis, db } from './clients.js';
import { checkHealth } from './health.js';

const app = express();
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  const health = await checkHealth();
  res.status(health.ok ? 200 : 503).json(health);
});

await redis.connect();

const server = app.listen(config.port, () => {
  console.log(`pont server listening on port ${config.port}`);
});

async function shutdown() {
  server.close();
  await Promise.allSettled([redis.quit(), db.end()]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
