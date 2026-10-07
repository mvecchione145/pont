import { useEffect, useState } from 'react';
import { href } from '../route';

interface ServiceStatus {
  ok: boolean;
  detail: string;
}

interface Health {
  ok: boolean;
  services: Record<string, ServiceStatus>;
}

export function Home({ entryCount }: { entryCount: number }) {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data: Health) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

  return (
    <section>
      <h2>Welcome to pont</h2>
      <p>
        Capture what your organization knows (business definitions, decisions, and processes) as
        Markdown entries. Agents will read them through MCP.
      </p>
      <p>
        {entryCount === 0
          ? 'There are no entries yet. '
          : entryCount === 1
            ? 'There is 1 entry. '
            : `There are ${entryCount} entries. `}
        <a href={href({ view: 'new', folder: '' })}>Write a new entry</a>.
      </p>

      <h3>Stack status</h3>
      {!health && <p className="muted">Checking…</p>}
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
    </section>
  );
}
