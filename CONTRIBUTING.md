# Contributing

Thanks for your interest. This is a small project; issues and pull requests are welcome.

## Setup

Requires Node.js 22 or newer and npm.

```sh
git clone https://github.com/aozmekik/fugue-text.git
cd fugue-text
npm ci            # installs dev dependencies and builds dist/ (prepare script)
```

## Everyday commands

| Command                                   | What it does                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `npm test`                                | Runs the test suite once (Vitest)                                        |
| `npm run test:coverage`                   | Tests with v8 coverage; fails below the thresholds in `vitest.config.ts` |
| `npm run lint`                            | ESLint (typescript-eslint strict-type-checked), zero warnings allowed    |
| `npm run typecheck`                       | `tsc` for everything, and for `src/` alone without DOM or Node types     |
| `npm run format` / `npm run format:check` | Prettier                                                                 |
| `npm run build`                           | Builds `dist/` (ESM + type declarations) with tsup                       |
| `npm run check`                           | Everything CI runs, in order, except `check:package`                     |
| `npm run check:package`                   | Installs the packed package in a fresh project (needs network access)    |
| `npm run bench`                           | Editing-trace benchmark (fugue-text and Yjs), under a minute             |
| `npm run bench:scaling`                   | Cost per edit versus document size, two to three minutes                 |
| `npm run example:relay`                   | End-to-end WebSocket relay demo                                          |
| `npm run example:browser`                 | Serves the two-tab demo on http://127.0.0.1:8787                         |

`npm run check:package` packs the library and installs the tarball into a temporary project. It
type-checks a strict consumer with TypeScript 5.7 (the oldest supported version), runs the README
quick start from `scripts/consumer/` and loads the package with `require()`. Keep
`scripts/consumer/quick-start.ts` identical to the quick start in the README.

Property tests run 200 cases each by default, except the three decoder fuzzers in
`test/encoding.test.ts`, which run five times as many (`fuzzNumRuns` in
`test/support/helpers.ts`). `FC_NUM_RUNS` sets the base count for a longer soak run (here 5,000
cases per property and 25,000 per decoder fuzzer):

```sh
FC_NUM_RUNS=5000 npx vitest run --testTimeout=0
```

Coverage does not depend on the random inputs: when a branch is reached only by some
property-test runs, give it a deterministic test as well, so that `npm run test:coverage`
reports the same figures on every run.

When a property test fails, fast-check prints a seed and a shrunk counterexample; turn it into a
regular unit test before fixing the bug.

## Guidelines

- Keep `src/` free of runtime dependencies and platform-specific APIs (`tsconfig.lib.json`
  compiles it without DOM or Node types).
- Every exported declaration needs a doc comment (enforced by ESLint).
- Changes to the algorithm must keep the differential test against `test/support/reference.ts`
  passing; that file is a deliberately naive transcription of the paper and should stay that way.
- Changes to the binary formats need a new format version and must keep decoding old data.
- Benchmark numbers in the README must come from a run you did; state the command, hardware and
  Node.js version next to them.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
