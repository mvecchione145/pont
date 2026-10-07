import { useEffect, useState } from 'react';

interface ServiceStatus {
  ok: boolean;
  detail: string;
}

interface Health {
  ok: boolean;
  services: Record<string, ServiceStatus>;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data: Health) => setHealth(data))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main>
      <h1>pont</h1>
      <p className="tagline">Bridging the context between humans and agents</p>

      <h2>Stack status</h2>
      {error && <p className="down">Could not reach the server: {error}</p>}
      {!health && !error && <p>Checking…</p>}
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
