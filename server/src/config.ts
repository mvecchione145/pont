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
  search: {
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'Xenova/bge-small-en-v1.5',
    modelCacheDir: process.env.MODEL_CACHE_DIR ?? './models',
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
