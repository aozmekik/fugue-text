import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/** Forces a full garbage collection; requires `node --expose-gc`. */
export function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('run with node --expose-gc');
  gc();
  gc();
}

/** Median of a non-empty list. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Runs `fn` `warmup` times unmeasured, then `runs` times; returns each measured duration in ms. */
export function measure(fn: () => void, runs: number, warmup = 2): number[] {
  for (let i = 0; i < warmup; i++) fn();
  const durations: number[] = [];
  for (let i = 0; i < runs; i++) {
    collectGarbage();
    const start = performance.now();
    fn();
    durations.push(performance.now() - start);
  }
  return durations;
}

/** Describes the machine and runtime, for the results header. */
export function environment(): Record<string, string> {
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} (${String(os.cpus().length)} logical cores)`,
    memory: `${String(Math.round(os.totalmem() / 2 ** 30))} GiB`,
  };
}

/** Formats a number with thousands separators. */
export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Writes machine-readable results to bench/out (git-ignored). */
export function writeResults(name: string, data: unknown): string {
  const dir = new URL('./out/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${name}.json`, dir);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return fileURLToPath(file);
}

/** Renders rows as a Markdown table. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
