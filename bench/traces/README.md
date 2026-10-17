# Editing traces

## `automerge-paper.json.gz`

The keystroke-by-keystroke editing trace of the LaTeX source of the paper _A Conflict-Free
Replicated JSON Datatype_ (Martin Kleppmann and Alastair R. Beresford), recorded by Martin
Kleppmann: 182,315 single-character insertions and 77,463 single-character deletions
(259,778 edits) producing a 104,852-character ASCII document. It is a single-user trace that was
flattened into a linear history.

- Original data: [automerge/automerge-perf](https://github.com/automerge/automerge-perf)
  (`edit-by-index/`), © Martin Kleppmann, licensed under
  [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
- This file is the JSON conversion published in
  [josephg/editing-traces](https://github.com/josephg/editing-traces)
  (`sequential_traces/automerge-paper.json.gz`, commit `dfcb07e8fa793b9b04f2387997e0841b3a0bf628`),
  which states that the data set is copied from automerge-perf.
- Vendored unmodified. SHA-256:
  `42c0ff1720c0cad77077e190e36135c9cab9f7bbc266351c0a7fe4981c6a1546`.

Format (see the editing-traces README): `{ startContent, endContent, txns: [{ patches }] }`, where
each patch is `[position, deletedCount, insertedText]` with positions in Unicode code points. This
trace is pure ASCII, so code points and UTF-16 code units coincide.

The file is data only; the benchmark parses it with `JSON.parse` and never executes it.
