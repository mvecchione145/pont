import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import '@milkdown/crepe/theme/common/style.css';
import { LinkPicker, type Picked, type PickerKeys } from './LinkPicker';

export interface EditorHandle {
  // Puts the cursor at the start of the document, like pressing Enter in a
  // Notion page title.
  focusStart: () => void;
}

// A diamond (the ontology's mark in the sidebar) with a chain link. Drawn as
// filled shapes, since Crepe colours its menu icons with "fill".
const ONTOLOGY_LINK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M9 1.5 16.5 9 9 16.5 1.5 9Zm0 3L4.5 9 9 13.5 13.5 9Z"/><path fill-rule="evenodd" d="M15 14.5h4a3.25 3.25 0 0 1 0 6.5h-4a3.25 3.25 0 0 1 0-6.5Zm0 2a1.25 1.25 0 0 0 0 2.5h4a1.25 1.25 0 0 0 0-2.5Z"/></svg>`;

interface Props {
  ref?: Ref<EditorHandle>;
  // Read once when the editor mounts. Remount (change the React key) to load
  // different content.
  initialMarkdown: string;
  onChange: (markdown: string) => void;
}

// Open link picker. "trigger": typed [[query in the text (from..to covers the
// [[ and the query, replaced by the link). "wrap": selected text becomes the
// link. "insert": a link is inserted at the cursor.
interface PickerState {
  mode: 'trigger' | 'wrap' | 'insert';
  query: string;
  from: number;
  to: number;
  x: number;
  y: number;
}

const TRIGGER = /\[\[([^[\]\n￼]{0,60})$/;

// Notion-style block editor (Milkdown Crepe) that reads and writes Markdown
// directly: "/" opens the block menu, blocks have drag handles, and selecting
// text shows a formatting toolbar. Text links to the ontology, as a plain
// Markdown link to #/concept/<id> or #/relation/<id>, from "[[", from
// Cmd/Ctrl+Shift+K, from the toolbar's "Ontology link" button (selected text),
// or from "/" > Advanced > "Ontology link" (inserted at the cursor).
export function Editor({ ref, initialMarkdown, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const pickerRef = useRef<PickerState | null>(null);
  pickerRef.current = picker;
  const pickerKeys = useRef<PickerKeys>(null);

  const withView = <T,>(fn: (view: EditorView) => T): T | undefined => {
    const crepe = crepeRef.current;
    if (!crepe || !readyRef.current) return undefined;
    let out: T | undefined;
    crepe.editor.action((ctx) => {
      out = fn(ctx.get(editorViewCtx));
    });
    return out;
  };

  const openFromSelection = () =>
    withView((view) => {
      // ProseMirror syncs the browser's selection asynchronously, so a
      // shortcut pressed right after a double-click can see a stale one; read
      // the browser's selection directly when it is inside the editor.
      let { from, to } = view.state.selection;
      const dom = window.getSelection();
      if (dom && dom.anchorNode && dom.focusNode && view.dom.contains(dom.anchorNode) && view.dom.contains(dom.focusNode)) {
        try {
          const a = view.posAtDOM(dom.anchorNode, dom.anchorOffset);
          const b = view.posAtDOM(dom.focusNode, dom.focusOffset);
          from = Math.min(a, b);
          to = Math.max(a, b);
        } catch {
          // fall back to ProseMirror's selection
        }
      }
      const empty = from === to;
      const coords = view.coordsAtPos(from);
      setPicker({
        mode: empty ? 'insert' : 'wrap',
        query: empty ? '' : view.state.doc.textBetween(from, to, ' '),
        from,
        to,
        x: coords.left,
        y: coords.bottom,
      });
    });

  // The editor's menus are configured once, at mount; they call the latest
  // version of this through a ref.
  const openFromSelectionRef = useRef(openFromSelection);
  openFromSelectionRef.current = openFromSelection;

  useImperativeHandle(ref, () => ({
    focusStart() {
      withView((view) => {
        view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)));
        view.focus();
      });
    },
  }));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: initialMarkdown,
      features: {
        [CrepeFeature.Latex]: false,
        [CrepeFeature.AI]: false,
        [CrepeFeature.ImageBlock]: false,
        [CrepeFeature.TopBar]: false,
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: { text: "Type '/' for commands, or [[ to link a concept", mode: 'block' },
        [CrepeFeature.BlockEdit]: {
          advancedGroup: { image: null, math: null },
          buildMenu: (builder) => {
            builder.getGroup('advanced').addItem('ontology-link', {
              label: 'Ontology link',
              icon: ONTOLOGY_LINK_ICON,
              onRun: (ctx) => {
                // Remove the typed "/query", then link at the cursor.
                const view = ctx.get(editorViewCtx);
                const { $from } = view.state.selection;
                const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
                const slash = before.lastIndexOf('/');
                if (slash >= 0) view.dispatch(view.state.tr.delete($from.start() + slash, $from.pos));
                view.focus();
                openFromSelectionRef.current();
              },
            });
          },
        },
        [CrepeFeature.Toolbar]: {
          buildToolbar: (builder) => {
            builder.getGroup('function').addItem('ontology-link', {
              label: 'Ontology link (⌘⇧K)',
              icon: ONTOLOGY_LINK_ICON,
              active: () => false,
              onRun: () => openFromSelectionRef.current(),
            });
          },
        },
      },
    });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        if (markdown !== prev) onChangeRef.current(markdown);
      });
    });

    crepeRef.current = crepe;
    crepe.create().then(() => {
      readyRef.current = true;
    });

    const root = rootRef.current!;

    // After each edit or cursor move, open/update/close the [[ picker.
    const checkTrigger = () => {
      const current = pickerRef.current;
      if (current && current.mode !== 'trigger') return;
      withView((view) => {
        const sel = view.state.selection;
        const $from = sel.$from;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 62), $from.parentOffset, undefined, '￼');
        const match = sel.empty ? TRIGGER.exec(before) : null;
        if (!match) {
          if (current) setPicker(null);
          return;
        }
        const coords = view.coordsAtPos(sel.from);
        setPicker({
          mode: 'trigger',
          query: match[1],
          from: sel.from - match[0].length,
          to: sel.from,
          x: coords.left,
          y: coords.bottom,
        });
      });
    };

    // While the [[ picker is open, its navigation keys go to the picker
    // instead of the editor (capture phase, before ProseMirror sees them).
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        openFromSelection();
        return;
      }
      if (pickerRef.current?.mode === 'trigger' && pickerKeys.current?.key(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Cmd/Ctrl-click opens an ontology link (or any in-app link).
    const onClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#/"]');
      if (link && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        window.location.hash = link.getAttribute('href')!;
      }
    };

    const onKeyUp = () => checkTrigger();
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('keyup', onKeyUp);
    root.addEventListener('mouseup', onKeyUp);
    root.addEventListener('click', onClick);
    return () => {
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('keyup', onKeyUp);
      root.removeEventListener('mouseup', onKeyUp);
      root.removeEventListener('click', onClick);
      readyRef.current = false;
      crepeRef.current = null;
      void crepe.destroy();
    };
    // initialMarkdown is only read on mount, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function link(picked: Picked) {
    const p = pickerRef.current;
    setPicker(null);
    if (!p) return;
    withView((view) => {
      const linkType = view.state.schema.marks.link;
      const mark = linkType.create({ href: `#/${picked.kind}/${picked.id}` });
      let tr = view.state.tr;
      let end: number;
      if (p.mode === 'wrap') {
        tr = tr.addMark(p.from, p.to, mark);
        end = p.to;
      } else {
        tr = tr.replaceWith(p.from, p.to, view.state.schema.text(picked.name, [mark]));
        end = p.from + picked.name.length;
      }
      // Continue typing after the link, as plain text.
      tr = tr.setSelection(TextSelection.create(tr.doc, end)).removeStoredMark(linkType);
      view.dispatch(tr);
      view.focus();
    });
  }

  return (
    <>
      <div className="editor-root" ref={rootRef} />
      {picker && (
        <LinkPicker
          ref={pickerKeys}
          mode={picker.mode === 'trigger' ? 'trigger' : 'search'}
          query={picker.query}
          x={picker.x}
          y={picker.y}
          onPick={link}
          onClose={() => {
            setPicker(null);
            withView((view) => view.focus());
          }}
        />
      )}
    </>
  );
}
