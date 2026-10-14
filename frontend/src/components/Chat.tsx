import { useEffect, useMemo, useRef, useState } from 'react';
import { Marked, type Tokens } from 'marked';
import { api, chat, type ChatTurn } from '../api';
import { href } from '../route';

// Chat with an agent that answers from pont, using the same tools agents get
// over MCP. The conversation is kept for the browser tab (sessionStorage);
// the server keeps nothing.

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ok?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolCall[];
  costUsd?: number | null;
  error?: string;
}

const STORAGE_KEY = 'pont:chat';

function load(): Message[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function save(messages: Message[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Storage may be unavailable; the chat still works.
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Answers are Markdown from a model that has read documentation, so raw HTML
// is shown as text, images as links, and links only go to pont pages or the web.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escape(text),
    link({ href: target, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      if (!/^(#\/|https?:\/\/|mailto:)/i.test(target)) return label;
      const external = !target.startsWith('#');
      return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ''}${external ? ' target="_blank" rel="noreferrer noopener"' : ''}>${label}</a>`;
    },
    image: ({ href: target, text }: Tokens.Image) =>
      /^https?:\/\//i.test(target) ? `<a href="${escape(target)}" target="_blank" rel="noreferrer noopener">${escape(text || target)}</a>` : escape(text),
  },
});

const pageLink = (path: unknown) => (typeof path === 'string' ? <a href={href({ view: 'page', path })}>{path}</a> : null);
const quoted = (value: unknown) => (typeof value === 'string' ? `“${value}”` : '');

// One line per tool call, in words.
function describeTool({ name, input }: ToolCall) {
  switch (name) {
    case 'search':
      return <>Searched {quoted(input.query)}</>;
    case 'read_entry':
      return <>Read {pageLink(input.path)}</>;
    case 'list_entries':
      return input.folder ? <>Listed pages in {quoted(input.folder)}</> : 'Listed pages';
    case 'get_concept':
      return <>Looked up {quoted(input.concept)}</>;
    case 'list_concepts':
      return 'Listed concepts';
    case 'explore_concept':
      return <>Explored the graph around {quoted(input.concept)}</>;
    case 'find_path':
      return <>Traced {quoted(input.from)} → {quoted(input.to)}</>;
    case 'propose_edit':
      return <>Proposed an edit to {pageLink(input.path)}</>;
    case 'propose_new_page':
      return <>Proposed a new page {quoted(input.path)}</>;
    case 'propose_concept':
      return <>Proposed concept {quoted(input.name)}</>;
    case 'propose_alias':
      return <>Proposed alias {quoted(input.alias)} for {quoted(input.concept)}</>;
    case 'propose_relation':
      return <>Proposed {quoted(input.from)} {String(input.type ?? '').replace(/_/g, ' ')} {quoted(input.to)}</>;
    case 'list_my_proposals':
      return 'Checked your proposals';
    default:
      return name;
  }
}

const cost = (usd: number) => (usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`);

function Answer({ message, streaming }: { message: Message; streaming: boolean }) {
  const html = useMemo(() => markdown.parse(message.text, { async: false }), [message.text]);
  return (
    <div className="chat-answer">
      {message.tools && message.tools.length > 0 && (
        <ul className="chat-tools">
          {message.tools.map((t) => (
            <li key={t.id} className={t.ok === false ? 'failed' : undefined}>
              <span className="chat-tool-mark" aria-hidden>
                {t.ok === undefined ? '…' : t.ok ? '✓' : '✕'}
              </span>
              {describeTool(t)}
            </li>
          ))}
        </ul>
      )}
      {message.text && <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: html }} />}
      {streaming && !message.text && <p className="muted">Thinking…</p>}
      {message.error && <div className="banner chat-error"><span>{message.error}</span></div>}
      {!streaming && typeof message.costUsd === 'number' && <p className="chat-cost">{cost(message.costUsd)}</p>}
    </div>
  );
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>(load);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.getLlmSettings().then((s) => setConfigured(s.configured), () => setConfigured(null));
    input.current?.focus();
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (!streaming) save(messages);
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  // Updates the answer being written (always the last message).
  const update = (change: (m: Message) => Message) =>
    setMessages((all) => [...all.slice(0, -1), change(all[all.length - 1])]);

  async function send() {
    const text = draft.trim();
    if (!text || streaming) return;
    const history: ChatTurn[] = [
      ...messages.filter((m) => m.text.trim()).map((m) => ({ role: m.role, text: m.text })),
      { role: 'user', text },
    ];
    setMessages((all) => [...all, { role: 'user', text }, { role: 'assistant', text: '', tools: [] }]);
    setDraft('');
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      for await (const event of chat(history, controller.signal)) {
        if (event.type === 'text') update((m) => ({ ...m, text: m.text + event.text }));
        else if (event.type === 'tool') update((m) => ({ ...m, tools: [...(m.tools ?? []), { id: event.id, name: event.name, input: event.input }] }));
        else if (event.type === 'tool_result') {
          update((m) => ({ ...m, tools: m.tools?.map((t) => (t.id === event.id ? { ...t, ok: event.ok } : t)) }));
        } else if (event.type === 'done') update((m) => ({ ...m, costUsd: event.costUsd }));
        else if (event.type === 'error') update((m) => ({ ...m, error: event.message }));
      }
    } catch (err) {
      if (!controller.signal.aborted) update((m) => ({ ...m, error: (err as Error).message }));
    } finally {
      if (controller.signal.aborted) update((m) => ({ ...m, error: m.error ?? 'Stopped.' }));
      setStreaming(false);
      abort.current = null;
      input.current?.focus();
    }
  }

  function newChat() {
    abort.current?.abort();
    setMessages([]);
    setDraft('');
    input.current?.focus();
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <h1 className="page-title static">Chat</h1>
        {messages.length > 0 && (
          <button onClick={newChat} disabled={streaming}>
            New chat
          </button>
        )}
      </div>

      {configured === false && (
        <div className="empty-state">
          <p>Chat needs an LLM.</p>
          <a className="button primary" href={href({ view: 'settings' })}>
            Set it up in Settings
          </a>
        </div>
      )}

      {configured && messages.length === 0 && (
        <p className="lead">Ask anything about what's in pont. Answers cite the pages they come from. Uses the LLM set up in Settings, which costs money.</p>
      )}

      <div className="chat-messages">
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="chat-question">
              {m.text}
            </div>
          ) : (
            <Answer key={i} message={m} streaming={streaming && i === messages.length - 1} />
          ),
        )}
        <div ref={end} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          value={draft}
          rows={2}
          placeholder={messages.length ? 'Ask a follow-up' : 'How do we define an active user?'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={configured === false}
        />
        {streaming ? (
          <button type="button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!draft.trim() || configured === false}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
