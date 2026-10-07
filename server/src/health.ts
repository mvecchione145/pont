import { GetBucketVersioningCommand } from '@aws-sdk/client-s3';
import { s3, redis, db } from './clients.js';
import { config } from './config.js';

// Each check resolves to a short detail string, or throws if the dependency
// is unreachable or misconfigured.
export interface ServiceStatus {
  ok: boolean;
  detail: string;
}

export interface Health {
  ok: boolean;
  services: Record<string, ServiceStatus>;
}

const checks: Record<string, () => Promise<string>> = {
  async minio() {
    const { Status } = await s3.send(
      new GetBucketVersioningCommand({ Bucket: config.minio.bucket }),
    );
    if (Status !== 'Enabled') throw new Error(`versioning is ${Status ?? 'off'}`);
    return `bucket "${config.minio.bucket}", versioning enabled`;
  },

  async redis() {
    await redis.ping();
    const modules = (await redis.sendCommand(['MODULE', 'LIST'])) as Array<{ name: string }>;
    const names = modules.map((m) => String(m.name).toLowerCase());
    if (!names.includes('search')) throw new Error('RediSearch module not loaded');
    return 'search module loaded';
  },

  async postgres() {
    await db.query('SELECT 1');
    return 'connected';
  },

  async keycloak() {
    const url = `${config.keycloak.url}/realms/${config.keycloak.realm}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`realm "${config.keycloak.realm}" returned ${res.status}`);
    return `realm "${config.keycloak.realm}" available`;
  },
};

export async function checkHealth(): Promise<Health> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, ServiceStatus]> => {
      try {
        return [name, { ok: true, detail: await check() }];
      } catch (err) {
        return [name, { ok: false, detail: err instanceof Error ? err.message : String(err) }];
      }
    }),
  );
  const services = Object.fromEntries(entries);
  return { ok: entries.every(([, s]) => s.ok), services };
}
