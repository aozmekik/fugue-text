/** Loading and replaying the vendored editing trace; shared by the trace benchmarks. */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { FugueText } from '../src/index.js';
import type { Operation } from '../src/index.js';

/** One edit: `[position, deletedCount, insertedText]`, positions in code points (ASCII here). */
export type Patch = readonly [position: number, deleted: number, inserted: string];

interface TraceFile {
  readonly endContent: string;
  readonly txns: readonly { readonly patches: readonly Patch[] }[];
}

/** Reads `bench/traces/<name>.json.gz` (data only; parsed with JSON.parse). */
export function loadTrace(name = 'automerge-paper'): { patches: Patch[]; endContent: string } {
  const file = new URL(`./traces/${name}.json.gz`, import.meta.url);
  const trace = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as TraceFile;
  return { patches: trace.txns.flatMap((txn) => txn.patches), endContent: trace.endContent };
}

/** Replays the trace as local edits on one fugue-text replica. */
export function replayFugue(patches: readonly Patch[]): { doc: FugueText; ops: Operation[] } {
  const doc = new FugueText({ replicaId: 'author' });
  const ops: Operation[] = [];
  for (const [position, deleted, inserted] of patches) {
    if (deleted > 0) ops.push(doc.delete(position, deleted) as Operation);
    if (inserted.length > 0) ops.push(doc.insert(position, inserted) as Operation);
  }
  return { doc, ops };
}

/** Replays the trace as local edits on one Yjs document. */
export function replayYjs(
  patches: readonly Patch[],
  onUpdate?: (update: Uint8Array) => void,
): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  if (onUpdate !== undefined) doc.on('update', onUpdate);
  const text = doc.getText('text');
  for (const [position, deleted, inserted] of patches) {
    if (deleted > 0) text.delete(position, deleted);
    if (inserted.length > 0) text.insert(position, inserted);
  }
  return doc;
}
