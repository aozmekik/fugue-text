/**
 * Prints the heap retained by a document after replaying the trace, measured in a fresh process
 * so that other benchmarks' garbage cannot distort it. Usage: memory.ts fugue-text|yjs
 */

import { loadTrace, replayFugue, replayYjs } from './replay.js';
import { collectGarbage } from './util.js';

const library = process.argv[2];
const { patches } = loadTrace();
const build = (): unknown => {
  if (library === 'fugue-text') return replayFugue(patches).doc;
  if (library === 'yjs') return replayYjs(patches);
  throw new Error(`unknown library ${String(library)}`);
};
build(); // warm up the JIT so compiled code is not counted as document memory
collectGarbage();
const before = process.memoryUsage().heapUsed;
const doc = build();
collectGarbage();
const after = process.memoryUsage().heapUsed;
(globalThis as { retained?: unknown }).retained = doc;
console.log(JSON.stringify({ library, bytes: after - before }));
