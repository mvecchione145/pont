import { S3Client } from '@aws-sdk/client-s3';
import { createClient } from 'redis';
import pg from 'pg';
import neo4j from 'neo4j-driver';
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

// The ontology graph. Integers come back as plain numbers (counts and depths
// here are small).
export const graph = neo4j.driver(config.neo4j.url, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), {
  disableLosslessIntegers: true,
});
