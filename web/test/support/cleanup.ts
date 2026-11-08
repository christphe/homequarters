// One afterEach for every helper of web/test/support: unmount what Testing Library rendered, then undo each stub
// (in the reverse order they were made), then Vitest's own global stubs. Importing any helper registers it once
// per test file.
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
// what jsdom lacks, in place before the components load (every helper imports this module)
import "./canvas";
import "./mediaElements";

const undo: (() => void)[] = [];

/** Runs `f` after the current test (after the DOM is unmounted), once. */
export function onCleanup(f: () => void): void {
  undo.push(f);
}

const always: (() => void)[] = [];

/** Runs `f` after every test of the file, after the one-off undos above (resets of the fakes and the store). */
export function afterEveryTest(f: () => void): void {
  always.push(f);
}

afterEach(() => {
  cleanup();
  const errors: unknown[] = [];
  while (undo.length) {
    try {
      undo.pop()!();
    } catch (e) {
      errors.push(e);
    }
  }
  vi.unstubAllGlobals();
  for (const f of always) {
    try {
      f();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, errors.map(String).join("; "));
});
