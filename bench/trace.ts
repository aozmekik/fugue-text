/**
 * Replays the automerge-paper editing trace (259,778 single-character edits, see
 * bench/traces/README.md) through fugue-text and, for context, through Yjs.
 *
 * Run with `npm run bench` (BENCH_RUNS overrides the number of measured runs, default 7; the
 * retained heap is measured in as many fresh processes).
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { decodeOperation, encodeOperation, FugueText } from '../src/index.js';
import { internalList } from '../src/text.js';
import {
  loadTrace,
  replayFugue as replayFugueTrace,
  replayYjs as replayYjsTrace,
} from './replay.js';
import { environment, formatNumber, measure, median, table, writeResults } from './util.js';

const runs = Number(process.env['BENCH_RUNS'] ?? 7);
const yjsVersion = (createRequire(import.meta.url)('yjs/package.json') as { version: string })
  .version;
const trace = loadTrace();
const patches = trace.patches;
const replayFugue = () => replayFugueTrace(patches);
const replayYjs = (onUpdate?: (update: Uint8Array) => void) => replayYjsTrace(patches, onUpdate);

/**
 * Retained heap of a library's document in bytes, measured `count` times, each time in its own
 * fresh process (bench/memory.ts). The result varies slightly between processes.
 */
function retainedHeap(library: 'fugue-text' | 'yjs', count: number): number[] {
  const script = fileURLToPath(new URL('./memory.ts', import.meta.url));
  return Array.from({ length: count }, () => {
    const output = execFileSync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', script, library],
      { encoding: 'utf8' },
    );
    return (JSON.parse(output) as { bytes: number }).bytes;
  });
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`benchmark sanity check failed: ${what}`);
}

// --- fugue-text -------------------------------------------------------------------------------
const { doc: fugue, ops } = replayFugue();
check(fugue.toString() === trace.endContent, 'fugue-text local replay');
const encodedOps = ops.map(encodeOperation);
const fugueState = fugue.save();
const fugueJson = JSON.stringify(fugue.toJSON());
const remote = new FugueText({ replicaId: 'reader' });
for (const op of ops) remote.apply(op);
check(remote.toString() === trace.endContent, 'fugue-text remote replay');
check(FugueText.load(fugueState).toString() === trace.endContent, 'fugue-text load');

const fugueLocal = measure(() => replayFugue(), runs);
const fugueRemote = measure(() => {
  const doc = new FugueText({ replicaId: 'reader' });
  for (const op of ops) doc.apply(op);
}, runs);
const fugueRemoteBinary = measure(() => {
  const doc = new FugueText({ replicaId: 'reader' });
  for (const bytes of encodedOps) doc.apply(decodeOperation(bytes));
}, runs);
const fugueSave = measure(() => fugue.save(), runs);
const fugueLoad = measure(() => FugueText.load(fugueState), runs);
const fugueHeap = retainedHeap('fugue-text', runs);
const list = internalList(fugue);

// --- Yjs -------------------------------------------------------------------------------------
const updates: Uint8Array[] = [];
const yjs = replayYjs((update) => updates.push(update));
check(yjs.getText('text').toJSON() === trace.endContent, 'Yjs local replay');
const yjsState = Y.encodeStateAsUpdate(yjs);
const yjsStateV2 = Y.encodeStateAsUpdateV2(yjs);
const yjsLocal = measure(() => replayYjs(), runs);
const yjsRemote = measure(() => {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
}, runs);
const yjsSave = measure(() => Y.encodeStateAsUpdate(yjs), runs);
const yjsLoad = measure(() => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, yjsState);
}, runs);
const yjsHeap = retainedHeap('yjs', runs);
const checkDoc = new Y.Doc();
Y.applyUpdate(checkDoc, yjsState);
check(checkDoc.getText('text').toJSON() === trace.endContent, 'Yjs load');

// --- report ----------------------------------------------------------------------------------
const opsPerSecond = (durations: number[]): string =>
  formatNumber(patches.length / (median(durations) / 1000));
const ms = (durations: number[]): string => formatNumber(median(durations), 1);
const bytes = (count: number): string => formatNumber(count);
const sum = (arrays: readonly Uint8Array[]): number => arrays.reduce((n, a) => n + a.length, 0);
const opJsonBytes = ops.reduce((n, op) => n + Buffer.byteLength(JSON.stringify(op)), 0);

const rows: string[][] = [
  ['Local replay, edits/s (median)', opsPerSecond(fugueLocal), opsPerSecond(yjsLocal)],
  [
    'Remote replay from binary messages, edits/s (median)',
    opsPerSecond(fugueRemoteBinary),
    opsPerSecond(yjsRemote),
  ],
  [
    'Remote replay from in-memory operation objects, edits/s (median)',
    opsPerSecond(fugueRemote),
    'n/a (updates are binary)',
  ],
  ['Save full state, ms (median)', ms(fugueSave), ms(yjsSave)],
  ['Load full state, ms (median)', ms(fugueLoad), ms(yjsLoad)],
  [
    'Encoded state, bytes',
    bytes(fugueState.length),
    `${bytes(yjsState.length)} (v2: ${bytes(yjsStateV2.length)})`,
  ],
  [
    'Encoded state, gzip -6, bytes',
    bytes(gzipSync(fugueState).length),
    bytes(gzipSync(yjsState).length),
  ],
  ['State as JSON, bytes', bytes(Buffer.byteLength(fugueJson)), 'n/a'],
  ['All operations/updates, binary, bytes', bytes(sum(encodedOps)), bytes(sum(updates))],
  [
    'Bytes per operation/update (binary)',
    formatNumber(sum(encodedOps) / ops.length, 1),
    formatNumber(sum(updates) / updates.length, 1),
  ],
  ['All operations as JSON, bytes', bytes(opJsonBytes), 'n/a'],
  ['Retained heap after replay, bytes (median)', bytes(median(fugueHeap)), bytes(median(yjsHeap))],
];

const results = {
  trace: 'automerge-paper',
  edits: patches.length,
  finalLength: trace.endContent.length,
  runs,
  environment: environment(),
  fugueText: {
    operations: ops.length,
    runsInTree: list.runCount,
    segments: list.segmentCount,
    localMs: fugueLocal,
    remoteMs: fugueRemote,
    remoteBinaryMs: fugueRemoteBinary,
    saveMs: fugueSave,
    loadMs: fugueLoad,
    stateBytes: fugueState.length,
    stateJsonBytes: Buffer.byteLength(fugueJson),
    opsBinaryBytes: sum(encodedOps),
    opsJsonBytes: opJsonBytes,
    heapBytes: fugueHeap,
  },
  yjs: {
    version: yjsVersion,
    updates: updates.length,
    localMs: yjsLocal,
    remoteMs: yjsRemote,
    saveMs: yjsSave,
    loadMs: yjsLoad,
    stateBytes: yjsState.length,
    stateV2Bytes: yjsStateV2.length,
    updateBytes: sum(updates),
    heapBytes: yjsHeap,
  },
};
const file = writeResults('trace', results);

console.log(
  `Trace: automerge-paper, ${formatNumber(patches.length)} edits, final length ${formatNumber(trace.endContent.length)}`,
);
console.log(
  `Environment: ${Object.entries(environment())
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}`,
);
console.log(`Measured runs per metric: ${String(runs)} (after 2 warm-up runs); medians reported`);
console.log(
  `Retained heap: measured in ${String(runs)} fresh processes per library (bench/memory.ts); medians reported\n`,
);
console.log(table(['Metric', 'fugue-text', `Yjs ${yjsVersion}`], rows));

// The machine may be shared, so show how much the measured runs varied.
const range = (values: number[], digits = 1): string =>
  `${formatNumber(Math.min(...values), digits)} to ${formatNumber(Math.max(...values), digits)}`;
const rangeRows: string[][] = [
  ['Local replay, ms', range(fugueLocal), range(yjsLocal)],
  ['Remote replay from binary messages, ms', range(fugueRemoteBinary), range(yjsRemote)],
  ['Remote replay from in-memory operation objects, ms', range(fugueRemote), 'n/a'],
  ['Save full state, ms', range(fugueSave), range(yjsSave)],
  ['Load full state, ms', range(fugueLoad), range(yjsLoad)],
  ['Retained heap after replay, bytes', range(fugueHeap, 0), range(yjsHeap, 0)],
];
console.log(`\nRange over the ${String(runs)} measured runs:\n`);
console.log(table(['Metric', 'fugue-text', `Yjs ${yjsVersion}`], rangeRows));
console.log(
  `\nfugue-text structure: ${formatNumber(ops.length)} operations, ${formatNumber(list.runCount)} runs, ${formatNumber(list.segmentCount)} segments`,
);
console.log(`Raw results: ${file}`);
