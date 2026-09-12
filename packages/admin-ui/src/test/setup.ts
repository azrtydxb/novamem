/// <reference types="@testing-library/jest-dom" />
import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList);
  }
  // happy-dom (20.x) ships no Storage implementation, so anything that
  // persists a preference — the theme toggle, the active-project
  // selection — throws on `localStorage` under test. A Map-backed stand-in
  // is enough: these tests care that a key is written, read back and
  // removed, not about quota or cross-tab events.
  if (!("localStorage" in window) || !window.localStorage) {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k) => (store.has(k) ? store.get(k)! : null),
      key: (i) => [...store.keys()][i] ?? null,
      removeItem: (k) => {
        store.delete(k);
      },
      setItem: (k, v) => {
        store.set(String(k), String(v));
      },
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}
