import { S3Client } from '@aws-sdk/client-s3';
import { createClient } from 'redis';
import pg from 'pg';
import { config } from './config.js';

export const s3 = new S3Client({
  endpoint: config.minio.endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.minio.accessKey,
    secretAccessKey: config.minio.secretKey,
  },
});

export const redis = createClient({ url: config.redisUrl });
redis.on('error', (err) => console.error('redis error:', err.message));

export const db = new pg.Pool({ connectionString: config.databaseUrl });
