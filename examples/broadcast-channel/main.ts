/**
 * Collaborative textarea across browser tabs of the same origin, using BroadcastChannel as the
 * network. Open the page in two or more tabs and type in all of them.
 *
 * Protocol (all payloads are binary):
 * - `hello`: sent once on startup with this tab's state; every other tab merges it and replies
 *   with its own state (`state`), so a new tab catches up immediately;
 * - `op`: one encoded operation per local edit.
 * BroadcastChannel delivers each message to every other tab exactly once and in order, but
 * nothing here depends on that: operations are idempotent and buffered until causally ready.
 */

// In your own project: import { ... } from 'fugue-text';
import { decodeOperation, encodeOperation, Text } from '../../src/index.js';
import { TextareaBinding } from './textarea-binding.js';

type Message =
  | { readonly type: 'hello' | 'state'; readonly from: string; readonly state: Uint8Array }
  | { readonly type: 'op'; readonly from: string; readonly op: Uint8Array };

const textarea = document.querySelector('textarea');
const status = document.querySelector('#status');
if (textarea === null || status === null) throw new Error('missing elements');

const doc = new Text(); // a fresh random replica ID per tab
const channel = new BroadcastChannel('fugue-text-demo');
const post = (message: Message): void => {
  channel.postMessage(message);
};
const binding = new TextareaBinding(doc, textarea, (op) => {
  post({ type: 'op', from: doc.replicaId, op: encodeOperation(op) });
  render();
});

let received = 0;
function render(): void {
  if (status === null) return;
  const pending = doc.pendingCount > 0 ? `, ${String(doc.pendingCount)} buffered` : '';
  status.textContent = `replica ${doc.replicaId}: ${String(doc.length)} characters, ${String(received)} remote messages${pending}`;
}

channel.addEventListener('message', (event: MessageEvent<Message>) => {
  const message = event.data;
  received++;
  if (message.type === 'op') {
    binding.receive(decodeOperation(message.op));
  } else {
    binding.merge(message.state);
    if (message.type === 'hello') post({ type: 'state', from: doc.replicaId, state: doc.save() });
  }
  render();
});

post({ type: 'hello', from: doc.replicaId, state: doc.save() });
render();
