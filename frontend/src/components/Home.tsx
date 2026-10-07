import { useEffect, useState } from 'react';
import type { EntrySummary } from '../api';
import { href, nameOf } from '../route';

interface ServiceStatus {
  ok: boolean;
  detail: string;
}

interface Health {
  ok: boolean;
  services: Record<string, ServiceStatus>;
}

interface Props {
  entries: EntrySummary[];
  onNewPage: () => void;
}

export function Home({ entries, onNewPage }: Props) {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data: Health) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

  const recent = [...entries]
    .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))
    .slice(0, 6);

  return (
    <div className="page">
      <h1 className="page-title static">Home</h1>
      <p className="lead">
        Capture what your organization knows (definitions, decisions, and processes) as pages.
        Agents read them through MCP.
      </p>

      <h2 className="section-heading">Recently edited</h2>
      {recent.length === 0 ? (
        <div className="empty-state">
          <p>No pages yet. Start with something only your team knows.</p>
          <button className="primary" onClick={onNewPage}>
            New page
          </button>
        </div>
      ) : (
        <div className="cards">
          {recent.map((e) => (
            <a key={e.path} className="card" href={href({ view: 'page', path: e.path })}>
              <span className="card-icon">▤</span>
              <strong>{nameOf(e.path)}</strong>
              <span className="muted">{e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : 'Top level'}</span>
            </a>
          ))}
        </div>
      )}

      <h2 className="section-heading">Stack status</h2>
      {!health ? (
        <p className="muted">Checking…</p>
      ) : (
        <ul className="services">
          {Object.entries(health.services).map(([name, s]) => (
            <li key={name}>
              <span className={s.ok ? 'up' : 'down'}>●</span>
              <strong>{name}</strong>
              <span className="muted">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
