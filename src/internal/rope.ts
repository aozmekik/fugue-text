/**
 * A B-tree that stores a sequence of items, each with a non-negative weight, and supports:
 *
 * - finding the item that contains a given weight offset (`find`), in O(log n);
 * - computing the total weight before an item (`indexOf`), in O(log n), via back-pointers;
 * - inserting next to, and removing, a known item in O(log n) amortised.
 *
 * The CRDT uses it to map between visible indexes (weight = number of visible characters in a
 * segment) and segments of the Fugue tree, including zero-weight tombstone segments.
 *
 * Nodes are never rebalanced on removal (removal is rare here: it only happens when adjacent
 * tombstones are coalesced), so they may become under-full but never exceed their capacity.
 */

/** An item stored in a {@link Rope}. The rope owns the `leaf` back-pointer. */
export interface RopeItem {
  /** Set and maintained by the rope; do not modify. */
  leaf: unknown;
}

/** Computes an item's current weight. */
export type Weigher<T> = (item: T) => number;

/** Fan-out limits; small values are useful in tests to force splits. */
export interface RopeOptions {
  /** Maximum number of items per leaf (default 64, minimum 2). */
  readonly leafCapacity?: number;
  /** Maximum number of children per branch (default 32, minimum 2). */
  readonly branchCapacity?: number;
}

class Leaf<T> {
  items: T[] = [];
  weight = 0;
  parent: Branch<T> | undefined = undefined;
  prev: Leaf<T> | undefined = undefined;
  next: Leaf<T> | undefined = undefined;
}

class Branch<T> {
  children: Node<T>[] = [];
  weight = 0;
  parent: Branch<T> | undefined = undefined;
}

type Node<T> = Leaf<T> | Branch<T>;

/** Result of {@link Rope.find}. */
export interface RopePosition<T> {
  /** The item containing the requested offset. */
  readonly item: T;
  /** The offset within that item, `0 <= offset < weight(item)`. */
  readonly offset: number;
}

/** See the module documentation. */
export class Rope<T extends RopeItem> {
  readonly #weigh: Weigher<T>;
  readonly #leafCapacity: number;
  readonly #branchCapacity: number;
  #root: Node<T> = new Leaf<T>();
  #head: Leaf<T> = this.#root as Leaf<T>;
  #size = 0;

  /**
   * @param weigh - Returns an item's weight. Must stay consistent with the rope: after changing
   *   an item's weight, call {@link Rope.adjust}.
   * @param options - Fan-out limits.
   */
  constructor(weigh: Weigher<T>, options: RopeOptions = {}) {
    this.#weigh = weigh;
    this.#leafCapacity = Math.max(2, options.leafCapacity ?? 64);
    this.#branchCapacity = Math.max(2, options.branchCapacity ?? 32);
  }

  /** Builds a rope from items in order, packing leaves densely. O(n). */
  static from<T extends RopeItem>(
    items: readonly T[],
    weigh: Weigher<T>,
    options: RopeOptions = {},
  ): Rope<T> {
    const rope = new Rope(weigh, options);
    if (items.length === 0) return rope;
    let level: Node<T>[] = [];
    let previous: Leaf<T> | undefined;
    for (let start = 0; start < items.length; start += rope.#leafCapacity) {
      const leaf = new Leaf<T>();
      leaf.items = items.slice(start, start + rope.#leafCapacity);
      for (const item of leaf.items) {
        item.leaf = leaf;
        leaf.weight += weigh(item);
      }
      leaf.prev = previous;
      if (previous !== undefined) previous.next = leaf;
      previous = leaf;
      level.push(leaf);
    }
    rope.#head = level[0] as Leaf<T>;
    while (level.length > 1) {
      const parents: Node<T>[] = [];
      for (let start = 0; start < level.length; start += rope.#branchCapacity) {
        const branch = new Branch<T>();
        branch.children = level.slice(start, start + rope.#branchCapacity);
        for (const child of branch.children) {
          child.parent = branch;
          branch.weight += child.weight;
        }
        parents.push(branch);
      }
      level = parents;
    }
    rope.#root = level[0] as Node<T>;
    rope.#size = items.length;
    return rope;
  }

  /** Sum of all item weights. */
  get weight(): number {
    return this.#root.weight;
  }

  /** Number of items. */
  get size(): number {
    return this.#size;
  }

  /** The first item, if any. */
  first(): T | undefined {
    return this.#head.items[0];
  }

  /** The item after `item`, if any. */
  next(item: T): T | undefined {
    const leaf = leafOf(item);
    const index = leaf.items.indexOf(item);
    if (index + 1 < leaf.items.length) return leaf.items[index + 1];
    return leaf.next?.items[0];
  }

  /** The item before `item`, if any. */
  prev(item: T): T | undefined {
    const leaf = leafOf(item);
    const index = leaf.items.indexOf(item);
    if (index > 0) return leaf.items[index - 1];
    const prevLeaf = leaf.prev;
    return prevLeaf?.items[prevLeaf.items.length - 1];
  }

  /**
   * Finds the item containing weight offset `index`, skipping zero-weight items.
   * Returns `undefined` when `index` is outside `[0, weight)`.
   */
  find(index: number): RopePosition<T> | undefined {
    if (index < 0 || index >= this.#root.weight) return undefined;
    let node = this.#root;
    let remaining = index;
    while (node instanceof Branch) {
      let next: Node<T> | undefined;
      for (const child of node.children) {
        if (remaining < child.weight) {
          next = child;
          break;
        }
        remaining -= child.weight;
      }
      /* v8 ignore next */
      if (next === undefined) throw new Error('rope weights are inconsistent');
      node = next;
    }
    for (const item of node.items) {
      const weight = this.#weigh(item);
      if (remaining < weight) return { item, offset: remaining };
      remaining -= weight;
    }
    /* v8 ignore next */
    throw new Error('rope weights are inconsistent');
  }

  /** Total weight of the items before `item`. */
  indexOf(item: T): number {
    const leaf = leafOf(item);
    let total = 0;
    for (const other of leaf.items) {
      if (other === item) break;
      total += this.#weigh(other);
    }
    let node: Node<T> = leaf;
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      for (const child of parent.children) {
        if (child === node) break;
        total += child.weight;
      }
      node = parent;
    }
    return total;
  }

  /** Inserts `item` immediately after `ref`, or at the start when `ref` is `undefined`. */
  insertAfter(ref: T | undefined, item: T): void {
    if (ref === undefined) {
      this.#insertAt(this.#head, 0, item);
    } else {
      const leaf = leafOf(ref);
      this.#insertAt(leaf, leaf.items.indexOf(ref) + 1, item);
    }
  }

  /** Inserts `item` immediately before `ref`. */
  insertBefore(ref: T, item: T): void {
    const leaf = leafOf(ref);
    this.#insertAt(leaf, leaf.items.indexOf(ref), item);
  }

  /** Records that `item`'s weight changed by `delta` (the item must already reflect it). */
  adjust(item: T, delta: number): void {
    if (delta !== 0) addWeight(leafOf(item), delta);
  }

  /** Removes `item`. */
  remove(item: T): void {
    const leaf = leafOf(item);
    leaf.items.splice(leaf.items.indexOf(item), 1);
    item.leaf = undefined;
    this.#size--;
    addWeight(leaf, -this.#weigh(item));
    if (leaf.items.length === 0 && leaf.parent !== undefined) this.#removeNode(leaf);
  }

  /** Iterates over all items in order. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let leaf: Leaf<T> | undefined = this.#head; leaf !== undefined; leaf = leaf.next) {
      yield* leaf.items;
    }
  }

  /**
   * Verifies every structural invariant (weights, back-pointers, capacities, leaf links) and
   * throws on the first violation. Intended for tests.
   */
  checkInvariants(): void {
    const leaves: Leaf<T>[] = [];
    let size = 0;
    const visit = (node: Node<T>, parent: Branch<T> | undefined, depth: number): number => {
      assert(node.parent === parent, 'parent pointer');
      if (node instanceof Leaf) {
        leaves.push(node);
        assert(node.items.length <= this.#leafCapacity, 'leaf capacity');
        assert(node.items.length > 0 || node === this.#root, 'empty leaf');
        let weight = 0;
        for (const item of node.items) {
          assert(item.leaf === node, 'item back-pointer');
          weight += this.#weigh(item);
        }
        size += node.items.length;
        assert(weight === node.weight, 'leaf weight');
        return depth;
      }
      assert(node.children.length > 0, 'empty branch');
      assert(node.children.length <= this.#branchCapacity, 'branch capacity');
      let weight = 0;
      let leafDepth = -1;
      for (const child of node.children) {
        const childDepth = visit(child, node, depth + 1);
        assert(leafDepth === -1 || leafDepth === childDepth, 'unbalanced');
        leafDepth = childDepth;
        weight += child.weight;
      }
      assert(weight === node.weight, 'branch weight');
      return leafDepth;
    };
    visit(this.#root, undefined, 0);
    assert(size === this.#size, 'size');
    assert(leaves[0] === this.#head, 'head');
    for (let i = 0; i < leaves.length; i++) {
      assert(leaves[i]?.prev === leaves[i - 1], 'leaf prev link');
      assert(leaves[i]?.next === leaves[i + 1], 'leaf next link');
    }
  }

  #insertAt(leaf: Leaf<T>, index: number, item: T): void {
    leaf.items.splice(index, 0, item);
    item.leaf = leaf;
    this.#size++;
    addWeight(leaf, this.#weigh(item));
    if (leaf.items.length > this.#leafCapacity) this.#splitLeaf(leaf, index);
  }

  #splitLeaf(leaf: Leaf<T>, insertedAt: number): void {
    // Appending at the very end of the document is common (typing at the end): keep the full
    // leaf full and start a fresh one, instead of leaving two half-empty leaves behind.
    const count = leaf.items.length;
    const at = leaf.next === undefined && insertedAt === count - 1 ? count - 1 : count >> 1;
    const sibling = new Leaf<T>();
    sibling.items = leaf.items.splice(at);
    for (const item of sibling.items) {
      item.leaf = sibling;
      sibling.weight += this.#weigh(item);
    }
    leaf.weight -= sibling.weight;
    sibling.prev = leaf;
    sibling.next = leaf.next;
    if (leaf.next !== undefined) leaf.next.prev = sibling;
    leaf.next = sibling;
    this.#insertSibling(leaf, sibling);
  }

  #splitBranch(branch: Branch<T>): void {
    const sibling = new Branch<T>();
    sibling.children = branch.children.splice(branch.children.length >> 1);
    for (const child of sibling.children) {
      child.parent = sibling;
      sibling.weight += child.weight;
    }
    branch.weight -= sibling.weight;
    this.#insertSibling(branch, sibling);
  }

  /** Inserts `sibling` (split off `node`, so its weight is already counted above) after `node`. */
  #insertSibling(node: Node<T>, sibling: Node<T>): void {
    const parent = node.parent;
    if (parent === undefined) {
      const root = new Branch<T>();
      root.children = [node, sibling];
      root.weight = node.weight + sibling.weight;
      node.parent = root;
      sibling.parent = root;
      this.#root = root;
      return;
    }
    parent.children.splice(parent.children.indexOf(node) + 1, 0, sibling);
    sibling.parent = parent;
    if (parent.children.length > this.#branchCapacity) this.#splitBranch(parent);
  }

  /** Detaches an empty, non-root node (weights are already up to date). */
  #removeNode(node: Node<T>): void {
    if (node instanceof Leaf) {
      if (node.prev !== undefined) node.prev.next = node.next;
      if (node.next !== undefined) node.next.prev = node.prev;
      if (this.#head === node && node.next !== undefined) this.#head = node.next;
    }
    const parent = node.parent;
    /* v8 ignore next */
    if (parent === undefined) return;
    parent.children.splice(parent.children.indexOf(node), 1);
    node.parent = undefined;
    if (parent.children.length === 0) {
      this.#removeNode(parent);
      return;
    }
    // Collapse a root that is left with a single child, keeping the tree shallow.
    let root = this.#root;
    while (root instanceof Branch && root.children.length === 1) {
      root = root.children[0] as Node<T>;
      root.parent = undefined;
    }
    this.#root = root;
  }
}

function leafOf<T extends RopeItem>(item: T): Leaf<T> {
  const leaf = item.leaf;
  if (!(leaf instanceof Leaf)) throw new Error('item is not in a rope');
  return leaf as Leaf<T>;
}

function addWeight<T>(leaf: Leaf<T>, delta: number): void {
  for (let node: Node<T> | undefined = leaf; node !== undefined; node = node.parent) {
    node.weight += delta;
  }
}

function assert(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(`rope invariant violated: ${what}`);
}
