import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, CONCEPT_TYPES, RELATION_TYPES, type ConceptDetail, type RelationDetail } from '../api';
import { href, navigate } from '../route';
import { toRef, zoneName } from '../zones';

const human = (t: string) => t.replace(/_/g, ' ');

function LinkedFrom({ paths }: { paths: string[] }) {
  return (
    <section>
      <h2 className="section-heading">Linked from ({paths.length})</h2>
      {paths.length === 0 ? (
        <p className="muted">No pages link here yet. In a page, type [[ or press ⌘⇧K to link text to the ontology.</p>
      ) : (
        <ul className="plain-list">
          {paths.map((p) => (
            <li key={p}>
              <a href={href({ view: 'page', path: p })}>{p}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Sources({ sources }: { sources: { path: string; quote: string }[] }) {
  if (!sources.length) return null;
  return (
    <section>
      <h2 className="section-heading">Evidence</h2>
      <ul className="evidence">
        {sources.map((s, i) => (
          <li key={i}>
            <q>{s.quote}</q> — <a href={href({ view: 'page', path: s.path })}>{s.path}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Delete with a confirmation that says which pages still link here.
function DeleteButton({ what, linked, onDelete }: { what: string; linked: number; onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirming) {
    return (
      <button className="danger-text" onClick={() => setConfirming(true)}>
        Delete
      </button>
    );
  }
  return (
    <div className="restore-confirm">
      <span>
        Delete this {what}?{' '}
        {linked > 0
          ? `${linked} ${linked === 1 ? 'page links' : 'pages link'} to it; those links will lead nowhere.`
          : 'No pages link to it.'}
      </span>
      <button
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onDelete();
          setBusy(false);
        }}
      >
        Delete
      </button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
    </div>
  );
}

// Where an item sits: "Ontology / <zone> / …", the zone only when it isn't
// the default one.
function Breadcrumbs({ zone, last }: { zone: string; last: string }) {
  return (
    <p className="muted breadcrumbs-line">
      <a href={href({ view: 'ontology' })}>Ontology</a> /{' '}
      {zone && (
        <>
          <a href={href({ view: 'ontology', zone })}>{zoneName(zone)}</a> /{' '}
        </>
      )}
      {last}
    </p>
  );
}

// id is a ref: "<zone>/<id>", or "<id>" in the default zone.
export function ConceptPage({ id }: { id: string }) {
  const [c, setC] = useState<ConceptDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'Term', definition: '', aliases: '' });
  const [rel, setRel] = useState({ type: 'related_to', to: '', name: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.concept(id).then(setC, (err: Error) => setError(err.message));
  }, [id]);
  useEffect(load, [load]);

  function startEdit() {
    if (!c) return;
    setForm({ name: c.name, type: c.type, definition: c.definition, aliases: c.aliases.join(', ') });
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!c) return;
    try {
      await api.updateConcept(id, {
        name: form.name,
        type: form.type,
        definition: form.definition,
        aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
        expectedUpdatedAt: c.updatedAt,
      });
      setEditing(false);
      setNotice('Saved.');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addRelation(e: FormEvent) {
    e.preventDefault();
    if (!c) return;
    try {
      await api.createRelation(c.zone, { from: c.id, ...rel });
      setRel({ type: 'related_to', to: '', name: '', description: '' });
      setNotice('Relationship added.');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!c) return error ? <p className="down">{error}</p> : <p className="muted">Loading…</p>;

  return (
    <div className="ontology-item">
      <Breadcrumbs zone={c.zone} last={c.type} />

      {editing ? (
        <form className="settings-form" onSubmit={save}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Type
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {CONCEPT_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Definition
            <textarea rows={4} value={form.definition} onChange={(e) => setForm({ ...form, definition: e.target.value })} />
          </label>
          <label>
            Also called <span className="muted">(comma-separated)</span>
            <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
          </label>
          <div className="actions">
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h1 className="page-title static">{c.name}</h1>
          <p className="item-meta">
            <span className="pill">{c.type}</span>
            {c.aliases.length > 0 && <span className="muted"> Also called {c.aliases.join(', ')}</span>}
          </p>
          <p className="lead">{c.definition || <span className="muted">No definition yet.</span>}</p>
          <p className="muted hint">
            Last changed by {c.updatedBy} on {new Date(c.updatedAt).toLocaleString()}
          </p>
          <div className="actions">
            <button onClick={startEdit}>Edit</button>
            <DeleteButton
              what="concept"
              linked={c.linkedFrom.length}
              onDelete={async () => {
                try {
                  await api.deleteConcept(id);
                  navigate({ view: 'ontology', zone: c.zone || undefined });
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </div>
        </>
      )}

      {error && <p className="down">{error}</p>}
      {notice && <p className="up">{notice}</p>}

      <section>
        <h2 className="section-heading">Relationships ({c.relations.length})</h2>
        <ul className="plain-list">
          {c.relations.map((r) => (
            <li key={r.id}>
              <a href={href({ view: 'relation', id: toRef(c.zone, r.id) })}>{r.label}</a>
              {r.name && (
                <span className="muted">
                  {' '}
                  · {r.fromName} {human(r.type)} {r.toName}
                </span>
              )}
            </li>
          ))}
        </ul>
        <form className="add-relation" onSubmit={addRelation}>
          <span className="muted">{c.name}</span>
          <select value={rel.type} onChange={(e) => setRel({ ...rel, type: e.target.value })}>
            {RELATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {human(t)}
              </option>
            ))}
          </select>
          <input value={rel.to} onChange={(e) => setRel({ ...rel, to: e.target.value })} placeholder="Concept name" required />
          <input value={rel.name} onChange={(e) => setRel({ ...rel, name: e.target.value })} placeholder="Name (optional)" />
          <button type="submit">Add relationship</button>
        </form>
      </section>

      <LinkedFrom paths={c.linkedFrom} />
      <Sources sources={c.sources} />
    </div>
  );
}

export function RelationPage({ id }: { id: string }) {
  const [r, setR] = useState<RelationDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ from: '', type: 'related_to', to: '', name: '', description: '' });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.relation(id).then(setR, (err: Error) => setError(err.message));
  }, [id]);
  useEffect(load, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!r) return;
    try {
      await api.updateRelation(id, { ...form, expectedUpdatedAt: r.updatedAt });
      setEditing(false);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!r) return error ? <p className="down">{error}</p> : <p className="muted">Loading…</p>;
  const concept = (c: RelationDetail['fromConcept'], fallback: string) =>
    c ? <a href={href({ view: 'concept', id: toRef(r.zone, c.id) })}>{c.name}</a> : <span className="muted">{fallback} (deleted)</span>;

  return (
    <div className="ontology-item">
      <Breadcrumbs zone={r.zone} last="Relationship" />
      {editing ? (
        <form className="settings-form" onSubmit={save}>
          <div className="relation-edit-row">
            <label>
              From
              <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} required />
            </label>
            <label>
              Type
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {RELATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {human(t)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              To
              <input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} required />
            </label>
          </div>
          <label>
            Name <span className="muted">(optional, e.g. “Peanut Butter & Jelly”)</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Description
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="actions">
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h1 className="page-title static">{r.label}</h1>
          <p className="relation-line">
            {concept(r.fromConcept, r.from)} <span className="pill">{human(r.type)}</span> {concept(r.toConcept, r.to)}
          </p>
          <p className="lead">{r.description || <span className="muted">No description.</span>}</p>
          {r.updatedBy && r.updatedAt && (
            <p className="muted hint">
              Last changed by {r.updatedBy} on {new Date(r.updatedAt).toLocaleString()}
            </p>
          )}
          <div className="actions">
            <button
              onClick={() => {
                setForm({
                  from: r.fromConcept?.name ?? r.from,
                  type: r.type,
                  to: r.toConcept?.name ?? r.to,
                  name: r.name ?? '',
                  description: r.description ?? '',
                });
                setEditing(true);
              }}
            >
              Edit
            </button>
            <DeleteButton
              what="relationship"
              linked={r.linkedFrom.length}
              onDelete={async () => {
                try {
                  await api.deleteRelation(id);
                  navigate(
                    r.fromConcept
                      ? { view: 'concept', id: toRef(r.zone, r.fromConcept.id) }
                      : { view: 'ontology', zone: r.zone || undefined },
                  );
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </div>
        </>
      )}
      {error && <p className="down">{error}</p>}
      <LinkedFrom paths={r.linkedFrom} />
      <Sources sources={r.sources} />
    </div>
  );
}
