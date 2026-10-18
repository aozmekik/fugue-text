/**
 * Two-way binding between a fugue-text document and a `<textarea>`.
 *
 * Local typing is turned into insert/delete operations by diffing the textarea's value; remote
 * operations are applied to the document and rendered back into the textarea while the caret and
 * selection are kept in place with anchors, so text typed by others never moves your cursor.
 */

// In your own project: import { FugueText, ... } from 'fugue-text';
import type { Anchor, Operation, FugueText } from '../../src/index.js';

/** The subset of HTMLTextAreaElement the binding needs (so it can be tested without a DOM). */
export interface TextareaLike {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: 'input', listener: () => void): void;
  removeEventListener(type: 'input', listener: () => void): void;
}

/** One edit that turns `before` into `after`. */
export interface Splice {
  readonly index: number;
  readonly deleted: number;
  readonly inserted: string;
}

/**
 * The smallest single splice turning `before` into `after`. `caret` (the cursor position after
 * the edit) disambiguates repeated characters: typing "a" into "a|a" is reported at index 1.
 */
export function diff(before: string, after: string, caret = after.length): Splice {
  const grown = Math.max(0, after.length - before.length);
  const prefixLimit = Math.min(before.length, after.length, Math.max(0, caret - grown));
  let start = 0;
  while (start < prefixLimit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  return { index: start, deleted: endBefore - start, inserted: after.slice(start, endAfter) };
}

/** See the module documentation. */
export class TextareaBinding {
  readonly #doc: FugueText;
  readonly #textarea: TextareaLike;
  readonly #send: (op: Operation) => void;
  readonly #onInput = (): void => {
    this.#handleInput();
  };

  /**
   * @param doc - The document to bind.
   * @param textarea - The element to keep in sync.
   * @param send - Called with every local operation, to broadcast it.
   */
  constructor(doc: FugueText, textarea: TextareaLike, send: (op: Operation) => void) {
    this.#doc = doc;
    this.#textarea = textarea;
    this.#send = send;
    textarea.value = doc.toString();
    textarea.addEventListener('input', this.#onInput);
  }

  /** Applies an operation from another replica. */
  receive(op: Operation): void {
    this.#preservingSelection(() => this.#doc.apply(op));
  }

  /** Merges a state from another replica. */
  merge(state: Uint8Array): void {
    this.#preservingSelection(() => {
      this.#doc.merge(state);
    });
  }

  /** Stops listening to the textarea. */
  destroy(): void {
    this.#textarea.removeEventListener('input', this.#onInput);
  }

  #handleInput(): void {
    const { index, deleted, inserted } = diff(
      this.#doc.toString(),
      this.#textarea.value,
      this.#textarea.selectionEnd,
    );
    const removal = this.#doc.delete(index, deleted);
    if (removal !== undefined) this.#send(removal);
    const insertion = this.#doc.insert(index, inserted);
    if (insertion !== undefined) this.#send(insertion);
  }

  #preservingSelection(change: () => void): void {
    const textarea = this.#textarea;
    // Anchors are taken right before the change, so they reflect the latest local selection.
    const start: Anchor = this.#doc.createAnchor(textarea.selectionStart, 'right');
    const end: Anchor = this.#doc.createAnchor(textarea.selectionEnd, 'left');
    const collapsed = textarea.selectionStart === textarea.selectionEnd;
    change();
    const text = this.#doc.toString();
    if (text === textarea.value) return;
    textarea.value = text;
    const endIndex = this.#doc.resolveAnchor(end) ?? text.length;
    const startIndex = collapsed ? endIndex : (this.#doc.resolveAnchor(start) ?? endIndex);
    textarea.setSelectionRange(Math.min(startIndex, endIndex), endIndex);
  }
}
