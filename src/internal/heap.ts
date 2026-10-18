/** A binary min-heap of values ordered by a numeric priority. */
export class MinHeap<T> {
  readonly #priorities: number[] = [];
  readonly #values: T[] = [];

  /** Number of entries. */
  get size(): number {
    return this.#values.length;
  }

  /** The smallest priority, or `Infinity` when empty. */
  peekPriority(): number {
    return this.#priorities[0] ?? Infinity;
  }

  /** Adds `value` with `priority`. O(log n). */
  push(priority: number, value: T): void {
    const priorities = this.#priorities;
    const values = this.#values;
    let i = values.length;
    priorities.push(priority);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((priorities[parent] as number) <= priority) break;
      priorities[i] = priorities[parent] as number;
      values[i] = values[parent] as T;
      i = parent;
    }
    priorities[i] = priority;
    values[i] = value;
  }

  /** Removes and returns a value with the smallest priority. O(log n). */
  pop(): T | undefined {
    const priorities = this.#priorities;
    const values = this.#values;
    const top = values[0];
    const lastPriority = priorities.pop();
    const lastValue = values.pop();
    if (values.length === 0 || lastPriority === undefined) return top;
    const n = values.length;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && (priorities[child + 1] as number) < (priorities[child] as number)) {
        child++;
      }
      if ((priorities[child] as number) >= lastPriority) break;
      priorities[i] = priorities[child] as number;
      values[i] = values[child] as T;
      i = child;
    }
    priorities[i] = lastPriority;
    values[i] = lastValue as T;
    return top;
  }
}
