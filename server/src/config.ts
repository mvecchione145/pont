function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  minio: {
    endpoint: `http://${required('MINIO_ENDPOINT')}:${process.env.MINIO_PORT ?? 9000}`,
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
    bucket: required('MINIO_BUCKET'),
  },
  redisUrl: required('REDIS_URL'),
  databaseUrl: required('DATABASE_URL'),
  // Encrypts secrets stored in Postgres (the LLM API key). Changing it makes
  // stored secrets unreadable; they must then be entered again.
  secretKey: required('PONT_SECRET_KEY'),
  search: {
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5',
    modelCacheDir: process.env.MODEL_CACHE_DIR ?? './models',
  },
  // Where browsers reach pont, for links back to it (e.g. the GitHub OAuth callback).
  publicUrl: (process.env.PONT_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  // Optional: a GitHub OAuth App, so people can connect GitHub to link repo
  // docs and publish changes as pull requests. Unset: GitHub features are off.
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    // GitHub Enterprise Server can point these at its own URLs.
    webUrl: (process.env.GITHUB_URL ?? 'https://github.com').replace(/\/+$/, ''),
    apiUrl: (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
  },
  keycloak: {
    // Reached from inside the Compose network (health checks, signing keys).
    url: required('KEYCLOAK_URL'),
    // Reached by browsers. Tokens carry this URL in their issuer claim.
    publicUrl: required('KEYCLOAK_PUBLIC_URL'),
    realm: required('KEYCLOAK_REALM'),
    clientId: required('KEYCLOAK_CLIENT_ID'),
  },
};
