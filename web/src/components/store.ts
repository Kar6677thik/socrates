import { useSyncExternalStore } from 'react';

/** Tiny global store: create(initial) -> { get, set, use }. */
export function create<T>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((s: T) => T)) {
      state = typeof next === 'function' ? (next as (s: T) => T)(state) : next;
      subs.forEach((f) => f());
    },
    use(): T {
      return useSyncExternalStore(
        (f) => (subs.add(f), () => subs.delete(f)),
        () => state,
      );
    },
  };
}
