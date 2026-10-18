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
 * Keys must not change while an item is in the index. Leaves store each item's key next to it,
 * so searches compare plain numbers, and branches store the exact smallest key of each child, so
 * a search never needs to backtrack. Queries first try the leaf that answered the previous
 * query, because edits tend to touch the same region of a document repeatedly.
 */

/** Fan-out limits; small values are useful in tests to force splits. */
export interface SortedIndexOptions {
  /** Maximum number of items per leaf (default 64, minimum 2). */
  readonly leafCapacity?: number;
  /** Maximum number of children per branch (default 32, minimum 2). */
  readonly branchCapacity?: number;
}

class Leaf<T> {
  keys: number[] = [];
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
  /** The leaf that answered the last query; valid while it is non-empty (see #leafFor). */
  #finger: Leaf<T> = this.#head;
  #size = 0;
  /**
   * The branches and child indexes on the path of the current insertion or removal, reused
   * between calls (only `#depth` entries are valid). Created once the root becomes a branch, so
   * an index that fits in one leaf (most of them) stays small.
   */
  #path: Branch<T>[] | undefined = undefined;
  #slots: number[] | undefined = undefined;
  #depth = 0;

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
    const leaf = this.#leafFor(key);
    const i = lastAtMost(leaf.keys, key);
    return i >= 0 && leaf.keys[i] === key ? leaf.items[i] : undefined;
  }

  /** The item with the greatest key `<= key`, if any. */
  floor(key: number): T | undefined {
    const leaf = this.#leafFor(key);
    // Empty only when the whole index is; if every key of the leaf is greater, so is every key.
    return leaf.items[lastAtMost(leaf.keys, key)];
  }

  /** The item with the smallest key `>= key`, if any. */
  ceiling(key: number): T | undefined {
    return this.after(key - 1);
  }

  /** The item with the smallest key `> key`, if any. */
  after(key: number): T | undefined {
    const leaf = this.#leafFor(key);
    const i = lastAtMost(leaf.keys, key) + 1;
    // Every key of the following leaves is greater than `key`: their separators are.
    return i < leaf.items.length ? leaf.items[i] : leaf.next?.items[0];
  }

  /**
   * Adds `item`. Returns `false`, and leaves the index unchanged, if an item with the same key is
   * already present.
   */
  insert(item: T): boolean {
    const key = this.#keyOf(item);
    const leaf = this.#descend(key);
    const keys = leaf.keys;
    const at = lastAtMost(keys, key) + 1;
    if (at > 0 && keys[at - 1] === key) return false;
    insertAt(keys, at, key);
    insertAt(leaf.items, at, item);
    this.#size++;
    // Only the first key of the whole index can lower separators: everything else lands in
    // the leaf whose separator is already at most `key`.
    if (at === 0) {
      for (let depth = 0; depth < this.#depth; depth++) {
        const branch = this.#path?.[depth] as Branch<T>;
        const slot = this.#slots?.[depth] as number;
        if (key < (branch.keys[slot] as number)) branch.keys[slot] = key;
      }
    }
    if (keys.length > this.#leafCapacity) this.#splitLeaf(leaf, at);
    return true;
  }

  /** Removes the item with `item`'s key, which must be present. */
  remove(item: T): void {
    const key = this.#keyOf(item);
    const leaf = this.#descend(key);
    const at = lastAtMost(leaf.keys, key);
    if (at < 0 || leaf.keys[at] !== key) throw new Error('internal error: key not in index');
    removeAt(leaf.keys, at);
    removeAt(leaf.items, at);
    if (--this.#size === 0) {
      this.#root = this.#head = this.#finger = new Leaf<T>();
      return;
    }
    // Fix the separators on the path, detaching nodes that became empty.
    let node: Node<T> = leaf;
    for (let depth = this.#depth - 1; depth >= 0; depth--) {
      const branch = this.#path?.[depth] as Branch<T>;
      const slot = this.#slots?.[depth] as number;
      if (node.keys.length === 0) {
        if (node instanceof Leaf) this.#unlink(node);
        branch.children.splice(slot, 1);
        branch.keys.splice(slot, 1);
      } else if (slot < branch.keys.length) {
        branch.keys[slot] = node.keys[0] as number;
      }
      node = branch;
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
   * Verifies every structural invariant (key order, stored keys, separator keys, capacities,
   * balance, leaf links) and throws on the first violation. Intended for tests.
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
        assert(node.keys.length === node.items.length, 'one key per item');
        node.items.forEach((item, i) => {
          const key = this.#keyOf(item);
          assert(node.keys[i] === key, 'stored key');
          assert(Number.isInteger(key) && key > previousKey, 'keys are increasing integers');
          previousKey = key;
        });
        size += node.items.length;
        return { min: node.keys[0] ?? NaN, depth };
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

  /**
   * The leaf whose key range contains `key`: the last leaf whose smallest key is `<= key`, or
   * the first leaf. Tries the previous answer first: a non-empty leaf is always part of the tree,
   * and it is the right one when its first key is at most `key` (or it is the first leaf) and the
   * next leaf's first key is greater.
   */
  #leafFor(key: number): Leaf<T> {
    const finger = this.#finger;
    if (
      finger.keys.length > 0 &&
      (finger.prev === undefined || (finger.keys[0] as number) <= key) &&
      (finger.next === undefined || (finger.next.keys[0] as number) > key)
    ) {
      return finger;
    }
    let node = this.#root;
    while (node instanceof Branch) {
      node = node.children[Math.max(0, lastAtMost(node.keys, key))] as Node<T>;
    }
    this.#finger = node;
    return node;
  }

  /** Like `#leafFor` without the shortcut, recording the path for insertions and removals. */
  #descend(key: number): Leaf<T> {
    let node = this.#root;
    let depth = 0;
    if (node instanceof Branch) {
      const path = (this.#path ??= []);
      const slots = (this.#slots ??= []);
      do {
        const slot = Math.max(0, lastAtMost(node.keys, key));
        path[depth] = node;
        slots[depth] = slot;
        depth++;
        node = node.children[slot] as Node<T>;
      } while (node instanceof Branch);
    }
    this.#depth = depth;
    this.#finger = node; // an emptied leaf is unlinked, which moves the finger to the head
    return node;
  }

  /** Splits an overflowing leaf, then any branch on the recorded path that overflows. */
  #splitLeaf(leaf: Leaf<T>, insertedAt: number): void {
    // Appending in key order is common (new runs, new segments at the end of a replica's
    // counters): keep the full leaf full instead of leaving two half-empty leaves behind.
    const count = leaf.items.length;
    const at = leaf.next === undefined && insertedAt === count - 1 ? count - 1 : count >> 1;
    const right = new Leaf<T>();
    right.keys = leaf.keys.splice(at);
    right.items = leaf.items.splice(at);
    right.prev = leaf;
    right.next = leaf.next;
    if (leaf.next !== undefined) leaf.next.prev = right;
    leaf.next = right;

    let sibling: Node<T> = right;
    let left: Node<T> = leaf;
    for (let depth = this.#depth - 1; depth >= 0; depth--) {
      const branch = this.#path?.[depth] as Branch<T>;
      const slot = (this.#slots?.[depth] as number) + 1;
      branch.children.splice(slot, 0, sibling);
      branch.keys.splice(slot, 0, sibling.keys[0] as number);
      if (branch.children.length <= this.#branchCapacity) return;
      const half = branch.children.length >> 1;
      const next = new Branch<T>();
      next.children = branch.children.splice(half);
      next.keys = branch.keys.splice(half);
      sibling = next;
      left = branch;
    }
    const root = new Branch<T>();
    root.children = [left, sibling];
    root.keys = [left.keys[0] as number, sibling.keys[0] as number];
    this.#root = root;
  }

  #unlink(leaf: Leaf<T>): void {
    if (leaf.prev !== undefined) leaf.prev.next = leaf.next;
    if (leaf.next !== undefined) leaf.next.prev = leaf.prev;
    if (this.#head === leaf && leaf.next !== undefined) this.#head = leaf.next;
    if (this.#finger === leaf) this.#finger = this.#head;
  }
}

/** `array.splice(index, 0, value)`, without the builtin's overhead on short arrays. */
function insertAt<V>(array: V[], index: number, value: V): void {
  let i = array.length;
  array.push(value);
  for (; i > index; i--) array[i] = array[i - 1] as V;
  array[index] = value;
}

/** `array.splice(index, 1)`, without the builtin's overhead on short arrays. */
function removeAt(array: unknown[], index: number): void {
  const last = array.length - 1;
  for (let i = index; i < last; i++) array[i] = array[i + 1];
  array.pop();
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

function assert(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(`sorted index invariant violated: ${what}`);
}
