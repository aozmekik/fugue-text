import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MinHeap } from '../src/internal/heap.js';
import { numRuns } from './support/helpers.js';

describe('MinHeap', () => {
  it('pops values in priority order', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 50 }))), (steps) => {
        const heap = new MinHeap<number>();
        const model: number[] = [];
        for (const [push, priority] of steps) {
          if (push || model.length === 0) {
            heap.push(priority, priority);
            model.push(priority);
            model.sort((a, b) => a - b);
          } else {
            expect(heap.peekPriority()).toBe(model[0]);
            expect(heap.pop()).toBe(model.shift());
          }
          expect(heap.size).toBe(model.length);
        }
        expect(heap.peekPriority()).toBe(model[0] ?? Infinity);
      }),
      { numRuns },
    );
    expect(new MinHeap<string>().pop()).toBeUndefined();
  });
});
