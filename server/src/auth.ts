import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';

export interface User {
  id: string;
  username: string;
  email?: string;
  name?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

const { url, publicUrl, realm, clientId } = config.keycloak;
const issuer = `${publicUrl}/realms/${realm}`;
const jwks = createRemoteJWKSet(
  new URL(`${url}/realms/${realm}/protocol/openid-connect/certs`),
);

interface KeycloakClaims extends JWTPayload {
  azp?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
}

async function verify(token: string): Promise<User> {
  const { payload } = await jwtVerify<KeycloakClaims>(token, jwks, { issuer });
  if (payload.azp !== clientId) throw new Error(`token was issued to "${payload.azp}"`);
  if (!payload.sub) throw new Error('token has no subject');
  return {
    id: payload.sub,
    username: payload.preferred_username ?? payload.sub,
    email: payload.email,
    name: payload.name,
  };
}

// Rejects the request with 401 unless it carries a valid Keycloak access
// token for the pont web client. On success, the caller is on req.user.
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) {
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'login required' });
    return;
  }
  try {
    req.user = await verify(token);
    next();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer error="invalid_token"')
      .json({ error: 'invalid token', reason });
  }
}
