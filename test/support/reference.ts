/**
 * A deliberately naive implementation of Fugue, transcribed from Algorithm 1 of Weidner &
 * Kleppmann (arXiv:2305.00583): one node per character, explicit child arrays, recursive
 * traversal, O(n) per operation. Used as the oracle in differential tests.
 */

import type { ElementId, Side } from '../../src/types.js';

interface RefNode {
  readonly id: ElementId | null;
  value: string | null;
  readonly leftChildren: RefNode[];
  readonly rightChildren: RefNode[];
}

/** One element-level insertion: what the paper broadcasts for each character. */
export interface RefInsert {
  readonly id: ElementId;
  readonly value: string;
  readonly parent: ElementId | null;
  readonly side: Side;
}

const key = (id: ElementId): string => `${id.replica}\u0000${String(id.counter)}`;

/** The paper's ID order: lexicographic on (replicaID, counter). */
function lessThan(a: ElementId, b: ElementId): boolean {
  return a.replica < b.replica || (a.replica === b.replica && a.counter < b.counter);
}

/** See the module documentation. */
export class ReferenceFugue {
  readonly #root: RefNode = { id: null, value: null, leftChildren: [], rightChildren: [] };
  readonly #nodes = new Map<string, RefNode>();

  /** All non-root nodes in document order, tombstones included. */
  #traverse(): RefNode[] {
    const out: RefNode[] = [];
    const visit = (node: RefNode): void => {
      for (const child of node.leftChildren) visit(child);
      if (node !== this.#root) out.push(node);
      for (const child of node.rightChildren) visit(child);
    };
    visit(this.#root);
    return out;
  }

  /** The visible text. */
  toString(): string {
    return this.#traverse()
      .map((node) => node.value ?? '')
      .join('');
  }

  /** IDs of the visible characters, in order. */
  visibleIds(): ElementId[] {
    return this.#traverse()
      .filter((node) => node.value !== null)
      .map((node) => node.id as ElementId);
  }

  /**
   * The paper's local insert of one character at visible `index`: the new node is a right child
   * of the node at `index - 1` (or the root) if that node has no right children, and otherwise a
   * left child of the next node in the traversal, tombstones included.
   */
  insertLocal(index: number, value: string, id: ElementId): RefInsert {
    const all = this.#traverse();
    const visible = all.filter((node) => node.value !== null);
    const leftOrigin = index === 0 ? this.#root : (visible[index - 1] as RefNode);
    let insert: RefInsert;
    if (leftOrigin.rightChildren.length === 0) {
      insert = { id, value, parent: leftOrigin.id, side: 'right' };
    } else {
      const rightOrigin = all[
        leftOrigin === this.#root ? 0 : all.indexOf(leftOrigin) + 1
      ] as RefNode;
      insert = { id, value, parent: rightOrigin.id, side: 'left' };
    }
    this.insertRemote(insert);
    return insert;
  }

  /** Adds a node to the tree, among its same-side siblings in ascending ID order. */
  insertRemote(insert: RefInsert): void {
    if (this.#nodes.has(key(insert.id))) return;
    const parent = insert.parent === null ? this.#root : this.#nodes.get(key(insert.parent));
    if (parent === undefined) throw new Error('reference: unknown parent');
    const node: RefNode = {
      id: insert.id,
      value: insert.value,
      leftChildren: [],
      rightChildren: [],
    };
    const siblings = insert.side === 'left' ? parent.leftChildren : parent.rightChildren;
    let i = 0;
    while (i < siblings.length && lessThan((siblings[i] as RefNode).id as ElementId, insert.id))
      i++;
    siblings.splice(i, 0, node);
    this.#nodes.set(key(insert.id), node);
  }

  /** The ID of the visible character at `index`. */
  idAt(index: number): ElementId {
    return this.visibleIds()[index] as ElementId;
  }

  /** Turns a node into a tombstone. */
  delete(id: ElementId): void {
    const node = this.#nodes.get(key(id));
    if (node === undefined) throw new Error('reference: unknown element');
    node.value = null;
  }

  /** Whether the element is known. */
  has(id: ElementId): boolean {
    return this.#nodes.has(key(id));
  }
}
