/**
 * fugue-text: the Fugue list CRDT for collaborative plain-text editing.
 *
 * Implements Weidner & Kleppmann, "The Art of the Fugue: Minimizing Interleaving in Collaborative
 * Text Editing" (arXiv:2305.00583).
 * @packageDocumentation
 */

export { FugueTextError, type FugueTextErrorCode } from './errors.js';
export { assertOperation, decodeOperation, encodeOperation } from './operations.js';
export { FugueText, mergeStates } from './text.js';
export type {
  Anchor,
  AnchorBias,
  ApplyResult,
  ChangeEvent,
  ChangeListener,
  DeleteOperation,
  ElementId,
  ElementIdRange,
  InsertOperation,
  Operation,
  ReplicaId,
  Side,
  StateRecordJSON,
  TextChange,
  FugueTextOptions,
  TextStateJSON,
  VersionVector,
} from './types.js';
