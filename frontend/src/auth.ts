import Keycloak from 'keycloak-js';

interface AppConfig {
  keycloak: { url: string; realm: string; clientId: string };
}

let keycloak: Keycloak | null = null;

function client(): Keycloak {
  if (!keycloak) throw new Error('initAuth() has not run');
  return keycloak;
}

// Sends the browser to the Keycloak login page unless the user already has
// a session. Resolves once the user is logged in.
export async function initAuth(): Promise<void> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`could not load config (${res.status})`);
  const config: AppConfig = await res.json();

  keycloak = new Keycloak(config.keycloak);
  await keycloak.init({
    onLoad: 'login-required',
    pkceMethod: 'S256',
    checkLoginIframe: false,
  });
}

export function logout(): Promise<void> {
  return client().logout({ redirectUri: window.location.origin });
}

// fetch() for the pont API: refreshes the access token when it is about to
// expire and sends it as a bearer token.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const kc = client();
  await kc.updateToken(30);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${kc.token}`);
  return fetch(path, { ...init, headers });
}
