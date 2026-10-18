/**
 * An ordered set of items keyed by unique integers, stored as a B+tree: O(log n) insertion,
 * removal and floor/ceiling queries.
 *
 * The list layer keeps two kinds of index with it: one per replica that finds the segment
 * containing an element counter, and one per run and side that finds the child slot of an
 * element offset. Both used to be sorted arrays, whose `splice` made every split or insertion
 * O(k) in the size of the array, so editing inside one long run (a pasted document, for example)
 * slowed down with every edit.
 *
 * Keys must not change while an item is in the index. Branches store the exact smallest key of
 * each child, so a search never needs to backtrack.
 */

/** Fan-out limits; small values are useful in tests to force splits. */
export interface SortedIndexOptions {
  /** Maximum number of items per leaf (default 64, minimum 2). */
  readonly leafCapacity?: number;
  /** Maximum number of children per branch (default 32, minimum 2). */
  readonly branchCapacity?: number;
}

class Leaf<T> {
  items: T[] = [];
  prev: Leaf<T> | undefined = undefined;
  next: Leaf<T> | undefined = undefined;
}

class Branch<T> {
  /** `keys[i]` is the smallest key in `children[i]`. */
  keys: number[] = [];
  children: Node<T>[] = [];
}

type Node<T> = Leaf<T> | Branch<T>;

/** See the module documentation. */
export class SortedIndex<T> {
  readonly #keyOf: (item: T) => number;
  readonly #leafCapacity: number;
  readonly #branchCapacity: number;
  #root: Node<T> = new Leaf<T>();
  #head: Leaf<T> = this.#root as Leaf<T>;
  #size = 0;

  /**
   * @param keyOf - Returns an item's key: an integer that is unique within the index and does
   *   not change while the item is in it.
   * @param options - Fan-out limits.
   */
  constructor(keyOf: (item: T) => number, options: SortedIndexOptions = {}) {
    this.#keyOf = keyOf;
    this.#leafCapacity = Math.max(2, options.leafCapacity ?? 64);
    this.#branchCapacity = Math.max(2, options.branchCapacity ?? 32);
  }

  /** Number of items. */
  get size(): number {
    return this.#size;
  }

  /** The item with key `key`, if any. */
  get(key: number): T | undefined {
    const item = this.floor(key);
    return item !== undefined && this.#keyOf(item) === key ? item : undefined;
  }

  /** The item with the greatest key `<= key`, if any. */
  floor(key: number): T | undefined {
    let node = this.#root;
    while (node instanceof Branch) {
      const i = lastAtMost(node.keys, key);
      if (i < 0) return undefined;
      node = node.children[i] as Node<T>;
    }
    const items = node.items;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#keyOf(items[mid] as T) <= key) lo = mid + 1;
      else hi = mid;
    }
    return items[lo - 1];
  }

  /** The item with the smallest key `>= key`, if any. */
  ceiling(key: number): T | undefined {
    return this.#above(key, false);
  }

  /** The item with the smallest key `> key`, if any. */
  after(key: number): T | undefined {
    return this.#above(key, true);
  }

  /**
   * Adds `item`. Returns `false`, and leaves the index unchanged, if an item with the same key is
   * already present.
   */
  insert(item: T): boolean {
    const key = this.#keyOf(item);
    const sibling = this.#insertInto(this.#root, key, item);
    if (sibling === false) return false;
    if (sibling !== undefined) {
      const root = new Branch<T>();
      root.children = [this.#root, sibling];
      root.keys = [this.#minKey(this.#root), this.#minKey(sibling)];
      this.#root = root;
    }
    this.#size++;
    return true;
  }

  /** Removes the item with `item`'s key, which must be present. */
  remove(item: T): void {
    const key = this.#keyOf(item);
    if (!this.#removeFrom(this.#root, key)) throw new Error('internal error: key not in index');
    if (--this.#size === 0) {
      this.#root = this.#head = new Leaf<T>();
      return;
    }
    while (this.#root instanceof Branch && this.#root.children.length === 1) {
      this.#root = this.#root.children[0] as Node<T>;
    }
  }

  /** Iterates over all items in key order. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let leaf: Leaf<T> | undefined = this.#head; leaf !== undefined; leaf = leaf.next) {
      yield* leaf.items;
    }
  }

  /**
   * Verifies every structural invariant (key order, separator keys, capacities, balance, leaf
   * links) and throws on the first violation. Intended for tests.
   */
  checkInvariants(): void {
    const leaves: Leaf<T>[] = [];
    let size = 0;
    let previousKey = -Infinity;
    const visit = (node: Node<T>, depth: number): { min: number; depth: number } => {
      if (node instanceof Leaf) {
        leaves.push(node);
        assert(node.items.length <= this.#leafCapacity, 'leaf capacity');
        assert(node.items.length > 0 || node === this.#root, 'empty leaf');
        for (const item of node.items) {
          const key = this.#keyOf(item);
          assert(Number.isInteger(key) && key > previousKey, 'keys are increasing integers');
          previousKey = key;
        }
        size += node.items.length;
        return { min: node.items.length > 0 ? this.#keyOf(node.items[0] as T) : NaN, depth };
      }
      assert(node.children.length > 0, 'empty branch');
      assert(node.children.length <= this.#branchCapacity, 'branch capacity');
      assert(node.keys.length === node.children.length, 'one key per child');
      let leafDepth = -1;
      node.children.forEach((child, i) => {
        const result = visit(child, depth + 1);
        assert(result.min === node.keys[i], 'separator is the smallest key of its child');
        assert(leafDepth === -1 || leafDepth === result.depth, 'balanced');
        leafDepth = result.depth;
      });
      return { min: node.keys[0] as number, depth: leafDepth };
    };
    visit(this.#root, 0);
    assert(size === this.#size, 'size');
    assert(leaves[0] === this.#head, 'head');
    for (let i = 0; i < leaves.length; i++) {
      assert(leaves[i]?.prev === leaves[i - 1], 'leaf prev link');
      assert(leaves[i]?.next === leaves[i + 1], 'leaf next link');
    }
  }

  #above(key: number, strict: boolean): T | undefined {
    let node = this.#root;
    while (node instanceof Branch) {
      node = node.children[Math.max(0, lastAtMost(node.keys, key))] as Node<T>;
    }
    const items = node.items;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = this.#keyOf(items[mid] as T);
      if (strict ? other <= key : other < key) lo = mid + 1;
      else hi = mid;
    }
    // Every item of the following leaves is greater than `key`: their separators are.
    return lo < items.length ? items[lo] : node.next?.items[0];
  }

  /** Returns `false` for a duplicate key, the new right sibling if `node` split, else `undefined`. */
  #insertInto(node: Node<T>, key: number, item: T): Node<T> | false | undefined {
    if (node instanceof Leaf) {
      const items = node.items;
      let lo = 0;
      let hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.#keyOf(items[mid] as T) < key) lo = mid + 1;
        else hi = mid;
      }
      if (lo < items.length && this.#keyOf(items[lo] as T) === key) return false;
      items.splice(lo, 0, item);
      return items.length > this.#leafCapacity ? this.#splitLeaf(node, lo) : undefined;
    }
    const i = Math.max(0, lastAtMost(node.keys, key));
    const sibling = this.#insertInto(node.children[i] as Node<T>, key, item);
    if (sibling === false) return false;
    if (key < (node.keys[i] as number)) node.keys[i] = key;
    if (sibling === undefined) return undefined;
    node.children.splice(i + 1, 0, sibling);
    node.keys.splice(i + 1, 0, this.#minKey(sibling));
    if (node.children.length <= this.#branchCapacity) return undefined;
    const right = new Branch<T>();
    const half = node.children.length >> 1;
    right.children = node.children.splice(half);
    right.keys = node.keys.splice(half);
    return right;
  }

  #splitLeaf(leaf: Leaf<T>, insertedAt: number): Leaf<T> {
    // Appending in key order is common (new runs, new segments at the end of a replica's
    // counters): keep the full leaf full instead of leaving two half-empty leaves behind.
    const count = leaf.items.length;
    const at = leaf.next === undefined && insertedAt === count - 1 ? count - 1 : count >> 1;
    const right = new Leaf<T>();
    right.items = leaf.items.splice(at);
    right.prev = leaf;
    right.next = leaf.next;
    if (leaf.next !== undefined) leaf.next.prev = right;
    leaf.next = right;
    return right;
  }

  /** Removes `key` below `node`; returns whether it was found. Empty children are detached. */
  #removeFrom(node: Node<T>, key: number): boolean {
    if (node instanceof Leaf) {
      const items = node.items;
      let lo = 0;
      let hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.#keyOf(items[mid] as T) < key) lo = mid + 1;
        else hi = mid;
      }
      if (lo === items.length || this.#keyOf(items[lo] as T) !== key) return false;
      items.splice(lo, 1);
      return true;
    }
    const i = lastAtMost(node.keys, key);
    if (i < 0) return false;
    const child = node.children[i] as Node<T>;
    if (!this.#removeFrom(child, key)) return false;
    if (isEmpty(child)) {
      if (child instanceof Leaf) this.#unlink(child);
      node.children.splice(i, 1);
      node.keys.splice(i, 1);
    } else {
      node.keys[i] = this.#minKey(child);
    }
    return true;
  }

  #unlink(leaf: Leaf<T>): void {
    if (leaf.prev !== undefined) leaf.prev.next = leaf.next;
    if (leaf.next !== undefined) leaf.next.prev = leaf.prev;
    if (this.#head === leaf && leaf.next !== undefined) this.#head = leaf.next;
  }

  #minKey(node: Node<T>): number {
    return node instanceof Leaf ? this.#keyOf(node.items[0] as T) : (node.keys[0] as number);
  }
}

/** Index of the last element `<= key` in a sorted array, or -1. */
function lastAtMost(keys: readonly number[], key: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] as number) <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function isEmpty<T>(node: Node<T>): boolean {
  return node instanceof Leaf ? node.items.length === 0 : node.children.length === 0;
}

function assert(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(`sorted index invariant violated: ${what}`);
}
