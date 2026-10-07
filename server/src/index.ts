import express from 'express';
import { config } from './config.js';
import { redis, db } from './clients.js';
import { checkHealth } from './health.js';
import { requireUser } from './auth.js';

const app = express();
app.use(express.json());

// Public routes: Docker health checks and the frontend's login bootstrap.
app.get('/api/health', async (_req, res) => {
  const health = await checkHealth();
  res.status(health.ok ? 200 : 503).json(health);
});

app.get('/api/config', (_req, res) => {
  const { publicUrl, realm, clientId } = config.keycloak;
  res.json({ keycloak: { url: publicUrl, realm, clientId } });
});

// Everything registered below this line requires a logged-in user.
app.use('/api', requireUser);

app.get('/api/me', (req, res) => {
  res.json(req.user);
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
