import { useEffect, useState, type FormEvent } from 'react';
import { api, type LlmSettings, type Provider, type SampleQuestion } from '../api';
import { GithubSettings } from './GithubSettings';

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-opus-5-5',
  'openai-compatible': '',
};

type Tab = 'llm' | 'integrations';

const TABS: { id: Tab; label: string }[] = [
  { id: 'llm', label: 'LLM' },
  { id: 'integrations', label: 'Integrations' },
];

// The tab is in the URL (#/settings?tab=integrations), so links and GitHub's
// sign-in redirect open the right one.
function tabFromHash(): Tab {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return params.get('tab') === 'integrations' || params.has('github') ? 'integrations' : 'llm';
}

export function Settings() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <section className="settings">
      <h1 className="page-title static">Settings</h1>
      <nav className="game-tabs" aria-label="Settings">
        {TABS.map((t) => (
          <a key={t.id} href={`#/settings?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      {tab === 'llm' ? <LlmSettingsTab /> : <GithubSettings />}
    </section>
  );
}

// Settings → LLM: the model behind trivia, page review, and the ontology.
function LlmSettingsTab() {
  const [saved, setSaved] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(DEFAULT_MODEL.anthropic);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [sample, setSample] = useState<SampleQuestion | null>(null);

  useEffect(() => {
    api.getLlmSettings().then((s) => {
      setSaved(s);
      setProvider(s.provider);
      setModel(s.model);
      setBaseUrl(s.baseUrl);
    }, (err: Error) => setMessage({ ok: false, text: err.message }));
  }, []);

  function changeProvider(next: Provider) {
    setProvider(next);
    if (!model || model === DEFAULT_MODEL[provider]) setModel(DEFAULT_MODEL[next]);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setMessage(null);
    setSample(null);
    try {
      const next = await api.saveLlmSettings({
        provider,
        model,
        baseUrl,
        // Leaving the key empty keeps the saved one.
        ...(apiKey ? { apiKey } : {}),
      });
      setSaved(next);
      setApiKey('');
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function removeKey() {
    setBusy('save');
    try {
      setSaved(await api.saveLlmSettings({ provider, model, baseUrl, apiKey: '' }));
      setMessage({ ok: true, text: 'API key removed.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setMessage(null);
    setSample(null);
    try {
      const { sample } = await api.testLlm();
      setSample(sample);
      setMessage({ ok: true, text: 'It works. Here is a sample question:' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const dirty =
    saved !== null &&
    (provider !== saved.provider || model !== saved.model || baseUrl !== saved.baseUrl || apiKey !== '');

  return (
    <>

      <form className="settings-form" onSubmit={save}>
        <fieldset>
          <legend>Provider</legend>
          <label className="radio">
            <input
              type="radio"
              name="provider"
              checked={provider === 'anthropic'}
              onChange={() => changeProvider('anthropic')}
            />
            <span>
              <strong>Anthropic</strong>
              <span className="muted">Claude models through the Anthropic API.</span>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="provider"
              checked={provider === 'openai-compatible'}
              onChange={() => changeProvider('openai-compatible')}
            />
            <span>
              <strong>OpenAI-compatible</strong>
              <span className="muted">OpenAI, or a server with the same API: Ollama, vLLM, LiteLLM, and others.</span>
            </span>
          </label>
        </fieldset>

        <label>
          Model
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider === 'anthropic' ? 'claude-opus-5-5' : 'for example gpt-5 or llama3.1'}
            required
          />
        </label>

        <label>
          {provider === 'anthropic' ? 'Base URL (optional, for a proxy)' : 'Base URL'}
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1 or http://localhost:11434/v1'}
          />
        </label>

        <label>
          API key {provider === 'openai-compatible' && <span className="muted">(optional for local servers)</span>}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={saved?.hasKey ? `Saved (${saved.keyHint}). Leave empty to keep it.` : 'Paste your API key'}
            autoComplete="off"
          />
          <span className="hint muted">Stored encrypted on the server and never shown again.</span>
        </label>

        <div className="actions">
          <button type="submit" className="primary" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={test} disabled={busy !== null || dirty || !saved?.configured}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          {saved?.hasKey && (
            <button type="button" onClick={removeKey} disabled={busy !== null}>
              Remove API key
            </button>
          )}
        </div>
        {dirty && saved?.configured && <p className="muted hint">Save your changes before testing.</p>}
        {saved?.updatedBy && (
          <p className="muted hint">
            Last changed by {saved.updatedBy} on {new Date(saved.updatedAt!).toLocaleString()}.
          </p>
        )}
      </form>

      {message && <p className={message.ok ? 'up' : 'down'}>{message.text}</p>}
      {sample && (
        <div className="sample">
          <p>
            <strong>{sample.question}</strong>
          </p>
          <ul>
            <li className="up">✓ {sample.correct_answer}</li>
            {sample.wrong_answers.map((a) => (
              <li key={a}>✗ {a}</li>
            ))}
          </ul>
          <p className="muted">{sample.explanation}</p>
        </div>
      )}
    </>
  );
}
