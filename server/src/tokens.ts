import { createHash, randomBytes } from 'node:crypto';
import { db } from './clients.js';
import type { User } from './auth.js';

// Personal API tokens let a user's agents (Claude Code first) call the MCP
// endpoint as that user. pont issues them, shows each one once, and stores
// only its SHA-256 hash. Tokens carry 256 bits of randomness, so a fast hash
// is safe here; there is nothing to brute-force.

const TOKEN_PREFIX = 'pont_';
const DISPLAY_LENGTH = TOKEN_PREFIX.length + 6;

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const toInfo = (row: TokenRow): TokenInfo => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});

export async function createToken(user: User, name: string): Promise<{ token: string; info: TokenInfo }> {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const { rows } = await db.query<TokenRow>(
    `INSERT INTO api_tokens (user_id, user_name, username, name, prefix, token_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, prefix, created_at, last_used_at`,
    [user.id, user.name ?? user.username, user.username, name, token.slice(0, DISPLAY_LENGTH), hash(token)],
  );
  return { token, info: toInfo(rows[0]) };
}

export async function listTokens(userId: string): Promise<TokenInfo[]> {
  const { rows } = await db.query<TokenRow>(
    `SELECT id, name, prefix, created_at, last_used_at FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toInfo);
}

// Returns false if the token doesn't exist, belongs to someone else, or is
// already revoked.
export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE api_tokens SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  return rowCount === 1;
}

// Resolves a raw token to its owner, or null if it is unknown or revoked.
export async function authenticateToken(token: string): Promise<User | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const { rows } = await db.query<{ user_id: string; user_name: string; username: string }>(
    `UPDATE api_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING user_id, user_name, username`,
    [hash(token)],
  );
  if (rows.length === 0) return null;
  const { user_id, user_name, username } = rows[0];
  return { id: user_id, username, name: user_name };
}
