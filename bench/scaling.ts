/**
 * How the cost of one edit grows with document size (synthetic workload).
 *
 * For each size N, a document of N characters is built from random "typing bursts" (words of 1 to
 * 8 characters at random positions, with occasional deletions), then 10,000 random
 * single-character edits (alternating insert and delete at uniformly random positions) are timed
 * on fresh copies of the document (median of 5 repetitions after a warm-up).
 * The same edit script is applied to fugue-text (locally, and remotely on a second replica), to
 * Yjs for context, and to the naive reference implementation from the test suite (O(n) per edit,
 * so only for small N).
 *
 * Run with `npm run bench:scaling`.
 */

import * as Y from 'yjs';
import { Text } from '../src/index.js';
import type { Operation } from '../src/index.js';
import { ReferenceFugue } from '../test/support/reference.js';
import { collectGarbage, environment, formatNumber, median, table, writeResults } from './util.js';

type Edit = readonly [position: number, deleted: number, inserted: string];

/** Small, fast, seeded PRNG (mulberry32) so every library gets the same script. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function buildScript(size: number, seed: number): Edit[] {
  const next = random(seed);
  const edits: Edit[] = [];
  let length = 0;
  while (length < size) {
    if (length > 0 && next() < 0.1) {
      const position = Math.floor(next() * length);
      const deleted = Math.min(1 + Math.floor(next() * 4), length - position);
      edits.push([position, deleted, '']);
      length -= deleted;
    } else {
      const word = 'abcdefgh'.slice(0, 1 + Math.floor(next() * 8));
      edits.push([Math.floor(next() * (length + 1)), 0, word]);
      length += word.length;
    }
  }
  return edits;
}

function probeScript(startLength: number, count: number, seed: number): Edit[] {
  const next = random(seed);
  const edits: Edit[] = [];
  let length = startLength;
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      edits.push([Math.floor(next() * (length + 1)), 0, 'x']);
      length++;
    } else {
      edits.push([Math.floor(next() * length), 1, '']);
      length--;
    }
  }
  return edits;
}

function lengthAfter(edits: readonly Edit[]): number {
  return edits.reduce((n, [, deleted, inserted]) => n - deleted + inserted.length, 0);
}

function applyFugue(doc: Text, edits: readonly Edit[], ops?: Operation[]): void {
  for (const [position, deleted, inserted] of edits) {
    const op = deleted > 0 ? doc.delete(position, deleted) : doc.insert(position, inserted);
    if (ops !== undefined && op !== undefined) ops.push(op);
  }
}

function applyYjs(text: Y.Text, edits: readonly Edit[]): void {
  for (const [position, deleted, inserted] of edits) {
    if (deleted > 0) text.delete(position, deleted);
    else text.insert(position, inserted);
  }
}

function applyReference(
  doc: ReferenceFugue,
  edits: readonly Edit[],
  counter: { value: number },
): void {
  for (const [position, deleted, inserted] of edits) {
    if (deleted > 0) {
      for (let i = 0; i < deleted; i++) doc.delete(doc.idAt(position));
    } else {
      for (let i = 0; i < inserted.length; i++) {
        doc.insertLocal(position + i, inserted.charAt(i), {
          replica: 'r',
          counter: counter.value++,
        });
      }
    }
  }
}

function nsPerEdit(count: number, run: () => void): number {
  collectGarbage();
  const start = performance.now();
  run();
  return ((performance.now() - start) * 1e6) / count;
}

const sizes = [1_000, 10_000, 100_000, 1_000_000];
const probeCount = 10_000;
const repetitions = 5;
const referenceLimit = 10_000;
const referenceProbeCount = 500;
const rows: string[][] = [];
const results: Record<string, unknown>[] = [];

for (const size of sizes) {
  const build = buildScript(size, size);
  const length = lengthAfter(build);
  const probe = probeScript(length, probeCount, size + 1);

  // Build each document once, then time the probe on fresh copies loaded from its state.
  const base = new Text({ replicaId: 'base' });
  applyFugue(base, build);
  const state = base.save();
  const ybase = new Y.Doc();
  applyYjs(ybase.getText('text'), build);
  const ystate = Y.encodeStateAsUpdate(ybase);
  const fugueLocalRuns: number[] = [];
  const fugueRemoteRuns: number[] = [];
  const yjsLocalRuns: number[] = [];
  for (let rep = 0; rep <= repetitions; rep++) {
    const local = Text.load(state, { replicaId: 'local' });
    const remote = Text.load(state, { replicaId: 'remote' });
    const ops: Operation[] = [];
    const localNs = nsPerEdit(probeCount, () => {
      applyFugue(local, probe, ops);
    });
    const remoteNs = nsPerEdit(probeCount, () => {
      for (const op of ops) remote.apply(op);
    });
    if (remote.toString() !== local.toString()) throw new Error('replicas diverged');
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, ystate);
    const ytext = ydoc.getText('text');
    const yjsNs = nsPerEdit(probeCount, () => {
      applyYjs(ytext, probe);
    });
    if (ytext.toJSON() !== local.toString()) throw new Error('Yjs disagrees with fugue-text');
    if (rep === 0) continue; // warm-up
    fugueLocalRuns.push(localNs);
    fugueRemoteRuns.push(remoteNs);
    yjsLocalRuns.push(yjsNs);
  }
  const fugueLocal = median(fugueLocalRuns);
  const fugueRemote = median(fugueRemoteRuns);
  const yjsLocal = median(yjsLocalRuns);

  // Reference implementation, small sizes only.
  let reference: number | undefined;
  if (size <= referenceLimit) {
    const doc = new ReferenceFugue();
    const counter = { value: 0 };
    applyReference(doc, build, counter);
    reference = nsPerEdit(referenceProbeCount, () => {
      applyReference(doc, probe.slice(0, referenceProbeCount), counter);
    });
  }

  rows.push([
    formatNumber(length),
    formatNumber(fugueLocal),
    formatNumber(fugueRemote),
    formatNumber(yjsLocal),
    reference === undefined ? 'skipped (O(n) per edit)' : formatNumber(reference),
  ]);
  results.push({
    length,
    fugueLocalNs: fugueLocal,
    fugueRemoteNs: fugueRemote,
    yjsLocalNs: yjsLocal,
    referenceNs: reference,
  });
}

const file = writeResults('scaling', {
  environment: environment(),
  probeCount,
  repetitions,
  results,
});
console.log('Synthetic workload: random typing bursts, then 10,000 random 1-character edits');
console.log(`Median of ${String(repetitions)} repetitions per size (reference: a single run)`);
console.log(
  `Environment: ${Object.entries(environment())
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}\n`,
);
console.log(
  table(
    [
      'Document length',
      'fugue-text local, ns/edit',
      'fugue-text remote, ns/edit',
      'Yjs local, ns/edit',
      'Naive reference, ns/edit',
    ],
    rows,
  ),
);
console.log(`\nRaw results: ${file}`);
