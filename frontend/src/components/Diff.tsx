// Renders a unified diff: removed lines red, added lines green, with the
// file headers dropped and hunks separated.
export function Diff({ patch, empty = 'No changes.' }: { patch: string; empty?: string }) {
  const lines = patch.split('\n').filter((l) => !/^(===|--- |\+\+\+ |Index: |\\ No newline)/.test(l));
  if (!lines.some((l) => l.startsWith('+') || l.startsWith('-'))) return <p className="muted">{empty}</p>;
  return (
    <pre className="diff" aria-label="Changes">
      {lines.map((line, i) => {
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        return (
          <span key={i} className={`diff-line ${kind}`}>
            {kind === 'hunk' ? '⋯' : line || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}
