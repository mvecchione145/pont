import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { Selection } from '@milkdown/kit/prose/state';
import '@milkdown/crepe/theme/common/style.css';

export interface EditorHandle {
  // Puts the cursor at the start of the document, like pressing Enter in a
  // Notion page title.
  focusStart: () => void;
}

interface Props {
  ref?: Ref<EditorHandle>;
  // Read once when the editor mounts. Remount (change the React key) to load
  // different content.
  initialMarkdown: string;
  onChange: (markdown: string) => void;
}

// Notion-style block editor (Milkdown Crepe) that reads and writes Markdown
// directly: "/" opens the block menu, blocks have drag handles, and selecting
// text shows a formatting toolbar.
export function Editor({ ref, initialMarkdown, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);

  useImperativeHandle(ref, () => ({
    focusStart() {
      const crepe = crepeRef.current;
      if (!crepe || !readyRef.current) return;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
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
        [CrepeFeature.Placeholder]: { text: "Type '/' for commands", mode: 'block' },
        [CrepeFeature.BlockEdit]: {
          advancedGroup: { image: null, math: null },
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
    return () => {
      readyRef.current = false;
      crepeRef.current = null;
      void crepe.destroy();
    };
    // initialMarkdown is only read on mount, by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-root" ref={rootRef} />;
}
