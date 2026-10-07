import { useEffect, useState } from 'react';
import { apiFetch, logout } from './auth';

interface ServiceStatus {
  ok: boolean;
  detail: string;
}

interface Health {
  ok: boolean;
  services: Record<string, ServiceStatus>;
}

interface User {
  id: string;
  username: string;
  email?: string;
  name?: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/me')
      .then((res) => {
        if (!res.ok) throw new Error(`server rejected the session (${res.status})`);
        return res.json();
      })
      .then((data: User) => setUser(data))
      .catch((err: Error) => setError(err.message));

    fetch('/api/health')
      .then((res) => res.json())
      .then((data: Health) => setHealth(data))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main>
      <header>
        <h1>pont</h1>
        {user && (
          <div className="account">
            <span>{user.name ?? user.username}</span>
            <button onClick={() => logout()}>Sign out</button>
          </div>
        )}
      </header>
      <p className="tagline">Bridging the context between humans and agents</p>

      {error && <p className="down">{error}</p>}

      <h2>Stack status</h2>
      {!health && <p>Checking…</p>}
      {health && (
        <ul className="services">
          {Object.entries(health.services).map(([name, s]) => (
            <li key={name}>
              <span className={s.ok ? 'up' : 'down'}>{s.ok ? '●' : '○'}</span>
              <strong>{name}</strong> {s.detail}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
