import { afterEach, describe, expect, it } from "vitest";

import { isTerminalFocused, shouldBypassGlobalTerminalShortcuts } from "./terminalFocus";

class MockHTMLElement {
  isConnected = false;
  className = "";
  closestMatches = new Set<string>();

  readonly classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  };

  closest(selector: string): MockHTMLElement | null {
    return this.closestMatches.has(selector) && this.isConnected ? this : null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isTerminalFocused", () => {
  it("returns false for detached terminal focus elements", () => {
    const detached = new MockHTMLElement();

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: detached } as unknown as Document;

    expect(isTerminalFocused()).toBe(false);
  });

  it("returns true for connected app terminal focus elements", () => {
    const attached = new MockHTMLElement();
    attached.isConnected = true;
    attached.closestMatches.add('[data-terminal-surface="app"] [data-terminal-focus-root="true"]');

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: attached } as unknown as Document;

    expect(isTerminalFocused()).toBe(true);
  });

  it("returns false for Corkdiff focus elements that bypass app terminal shortcuts", () => {
    const embedded = new MockHTMLElement();
    embedded.isConnected = true;
    embedded.closestMatches.add(
      '[data-terminal-surface="corkdiff"] [data-terminal-focus-root="true"]',
    );

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: embedded } as unknown as Document;

    expect(isTerminalFocused()).toBe(false);
    expect(shouldBypassGlobalTerminalShortcuts()).toBe(true);
  });

  it("returns false when the active element is connected but outside any terminal surface", () => {
    const active = new MockHTMLElement();
    active.isConnected = true;

    globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalThis.document = { activeElement: active } as unknown as Document;

    expect(isTerminalFocused()).toBe(false);
    expect(shouldBypassGlobalTerminalShortcuts()).toBe(false);
  });
});
