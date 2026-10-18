/**
 * How the cost of one edit grows with document size (synthetic workloads).
 *
 * For each size N, a document of N characters is built in one of two ways:
 * - `bursts`: random "typing bursts" (words of 1 to 8 characters at random positions, with
 *   occasional deletions), which produces many short runs;
 * - `paste`: a single insertion of N characters, which produces one long run that later edits
 *   cut into pieces (opening or pasting a file, then editing it).
 * Then 10,000 random single-character edits (alternating insert and delete at uniformly random
 * positions) are timed on fresh copies of the document (median of 5 repetitions after a warm-up).
 * The same edit script is applied to fugue-text (locally, and remotely on a second replica), to
 * Yjs for context, and, for the bursts workload, to the naive reference implementation from the
 * test suite (O(n) per edit, so only for small N).
 *
 * A final "drift" run pastes 1,000,000 characters and times 100,000 random edits in batches of
 * 10,000, to show whether the cost per edit grows as the run is cut into more segments.
 *
 * Run with `npm run bench:scaling`.
 */

import * as Y from 'yjs';
import { FugueText } from '../src/index.js';
import type { Operation } from '../src/index.js';
import { internalList } from '../src/text.js';
import { ReferenceFugue } from '../test/support/reference.js';
import { collectGarbage, environment, formatNumber, median, table, writeResults } from './util.js';

type Edit = readonly [position: number, deleted: number, inserted: string];
type Workload = 'bursts' | 'paste';

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

function burstScript(size: number, seed: number): Edit[] {
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

function pasteScript(size: number): Edit[] {
  return [[0, 0, 'abcdefghij'.repeat(Math.ceil(size / 10)).slice(0, size)]];
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

function applyFugue(doc: FugueText, edits: readonly Edit[], ops?: Operation[]): void {
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

interface Measurement {
  readonly workload: Workload;
  readonly length: number;
  /** ns per edit of every measured repetition, warm-up excluded. */
  readonly fugueLocalNs: number[];
  readonly fugueRemoteNs: number[];
  readonly yjsLocalNs: number[];
  /** A single run, bursts workload and small sizes only. */
  readonly referenceNs: number | undefined;
}

function measureSize(workload: Workload, size: number): Measurement {
  const build = workload === 'bursts' ? burstScript(size, size) : pasteScript(size);
  const length = lengthAfter(build);
  const probe = probeScript(length, probeCount, size + 1);

  // Build each document once, then time the probe on fresh copies loaded from its state.
  const base = new FugueText({ replicaId: 'base' });
  applyFugue(base, build);
  const state = base.save();
  const ybase = new Y.Doc();
  applyYjs(ybase.getText('text'), build);
  const ystate = Y.encodeStateAsUpdate(ybase);
  const fugueLocalNs: number[] = [];
  const fugueRemoteNs: number[] = [];
  const yjsLocalNs: number[] = [];
  for (let rep = 0; rep <= repetitions; rep++) {
    const local = FugueText.load(state, { replicaId: 'local' });
    const remote = FugueText.load(state, { replicaId: 'remote' });
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
    fugueLocalNs.push(localNs);
    fugueRemoteNs.push(remoteNs);
    yjsLocalNs.push(yjsNs);
  }

  let referenceNs: number | undefined;
  if (workload === 'bursts' && size <= referenceLimit) {
    const doc = new ReferenceFugue();
    const counter = { value: 0 };
    applyReference(doc, build, counter);
    referenceNs = nsPerEdit(referenceProbeCount, () => {
      applyReference(doc, probe.slice(0, referenceProbeCount), counter);
    });
  }
  return { workload, length, fugueLocalNs, fugueRemoteNs, yjsLocalNs, referenceNs };
}

/** ns per edit for consecutive batches of random edits after one large paste (fugue-text only). */
function measureDrift(size: number, batches: number): { nsPerBatch: number[]; segments: number[] } {
  const doc = new FugueText({ replicaId: 'drift' });
  applyFugue(doc, pasteScript(size));
  const probe = probeScript(size, probeCount * batches, 7);
  const nsPerBatch: number[] = [];
  const segments: number[] = [];
  for (let batch = 0; batch < batches; batch++) {
    const edits = probe.slice(batch * probeCount, (batch + 1) * probeCount);
    nsPerBatch.push(
      nsPerEdit(probeCount, () => {
        applyFugue(doc, edits);
      }),
    );
    segments.push(internalList(doc).segmentCount);
  }
  return { nsPerBatch, segments };
}

const measurements: Measurement[] = [];
for (const workload of ['bursts', 'paste'] as const) {
  for (const size of sizes) measurements.push(measureSize(workload, size));
}
const driftBatches = 10;
const drift = measureDrift(1_000_000, driftBatches);

const file = writeResults('scaling', {
  environment: environment(),
  probeCount,
  repetitions,
  measurements,
  drift: { length: 1_000_000, batchSize: probeCount, ...drift },
});

const ns = (values: readonly number[]): string => formatNumber(median(values));
const range = (values: readonly number[]): string =>
  `${formatNumber(Math.min(...values))} to ${formatNumber(Math.max(...values))}`;

console.log('Synthetic workloads: 10,000 random 1-character edits on documents of each size');
console.log(`Median of ${String(repetitions)} repetitions per size (reference: a single run)`);
console.log(
  `Environment: ${Object.entries(environment())
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}`,
);
for (const workload of ['bursts', 'paste'] as const) {
  console.log(
    `\nWorkload: ${workload === 'bursts' ? 'built from random typing bursts' : 'one paste'}\n`,
  );
  console.log(
    table(
      [
        'Document length',
        'fugue-text local, ns/edit',
        'fugue-text remote, ns/edit',
        'Yjs local, ns/edit',
        'Naive reference, ns/edit',
        'fugue-text local, range',
      ],
      measurements
        .filter((m) => m.workload === workload)
        .map((m) => [
          formatNumber(m.length),
          ns(m.fugueLocalNs),
          ns(m.fugueRemoteNs),
          ns(m.yjsLocalNs),
          m.referenceNs === undefined ? 'not run' : formatNumber(m.referenceNs),
          range(m.fugueLocalNs),
        ]),
    ),
  );
}
console.log(
  `\nDrift: one 1,000,000-character paste, then ${String(driftBatches)} batches of 10,000 random edits\n`,
);
console.log(
  table(
    ['Batch', 'fugue-text local, ns/edit', 'Segments after the batch'],
    drift.nsPerBatch.map((value, i) => [
      String(i + 1),
      formatNumber(value),
      formatNumber(drift.segments[i] as number),
    ]),
  ),
);
console.log(`\nRaw results: ${file}`);
