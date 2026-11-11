import { useEffect, useRef } from 'react';

export const isTyping = (e: KeyboardEvent | Event) => {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
};

/**
 * Keyboard shortcuts. Keys use KeyboardEvent.key with optional "mod+" (Ctrl or Cmd), "alt+", "shift+" prefixes.
 * Handlers return false to let the event through. Plain keys are ignored while typing unless `allowInInput`.
 */
export function useKeys(
  map: Record<string, (e: KeyboardEvent) => unknown>,
  opts: { enabled?: boolean; allowInInput?: string[] } = {},
) {
  const ref = useRef(map);
  ref.current = map;
  const allow = useRef(opts.allowInInput);
  allow.current = opts.allowInInput;
  useEffect(() => {
    if (opts.enabled === false) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push('mod');
      if (e.altKey) parts.push('alt');
      let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.altKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
      if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
      if (e.shiftKey && e.key.length !== 1) parts.push('shift');
      const combo = [...parts, key].join('+');
      const fn = ref.current[combo];
      if (!fn) return;
      const modified = parts.includes('mod') || parts.includes('alt');
      if (isTyping(e) && !modified && !allow.current?.includes(combo)) return;
      if (fn(e) === false) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts.enabled]);
}
