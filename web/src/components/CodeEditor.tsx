import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { go } from '@codemirror/lang-go';

function lang(name: string) {
  const n = name.toLowerCase();
  if (/^(js|javascript|jsx)$/.test(n)) return javascript({ jsx: true });
  if (/^(ts|typescript|tsx)$/.test(n)) return javascript({ typescript: true, jsx: true });
  if (/^(py|python)$/.test(n)) return python();
  if (/^(c|cpp|c\+\+|cc|h)$/.test(n)) return cpp();
  if (/^(java|kotlin)$/.test(n)) return java();
  if (n === 'rust' || n === 'rs') return rust();
  if (n === 'sql') return sql();
  if (n === 'go') return go();
  return [];
}

// Syntax colours from the app's tokens (same restrained scheme as rendered code blocks).
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--accent)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--good)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warn)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--text)', fontWeight: '600' },
    { tag: [t.variableName, t.propertyName, t.typeName, t.className], color: 'var(--text)' },
    { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--muted)' },
  ]),
);

// Quiet theme from the app's own tokens, so it follows light/dark automatically.
const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--code-bg)', color: 'var(--text)', fontSize: '13px', borderRadius: '10px', border: '1px solid var(--line)' },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: '10px 0', caretColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--faint)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in oklab, var(--text) 4%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--elev)', border: '1px solid var(--line-strong)' },
  '.cm-scroller': { minHeight: 'var(--cm-min, 180px)', maxHeight: '60vh' },
});

export default function CodeEditor({ value, onChange, language, readOnly, minHeight = 180, autoFocus }: {
  value: string; onChange?: (v: string) => void; language: string; readOnly?: boolean; minHeight?: number; autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const ro = useRef(new Compartment());

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          lang(language),
          highlight,
          theme,
          ro.current.of(EditorState.readOnly.of(!!readOnly)),
          EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current?.(u.state.doc.toString()); }),
        ],
      }),
    });
    if (autoFocus) view.current.focus();
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => { view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(!!readOnly)) }); }, [readOnly]);

  return <div ref={host} style={{ ['--cm-min' as any]: `${minHeight}px` }} />;
}
