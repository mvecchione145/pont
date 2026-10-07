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
  keycloak: {
    url: required('KEYCLOAK_URL'),
    realm: required('KEYCLOAK_REALM'),
  },
};
