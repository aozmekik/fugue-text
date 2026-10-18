// The README's quick start, compiled and run against the packed package by check-package.sh.
import { decodeOperation, encodeOperation, FugueText } from 'fugue-text';

const alice = new FugueText({ replicaId: 'alice' });
const bob = new FugueText({ replicaId: 'bob' });

// Local edits apply immediately and return an operation to broadcast.
const op = alice.insert(0, 'milk\n');
if (op) bob.apply(op);

// Concurrent edits at the same position...
const fromAlice = alice.insert(5, 'eggs\n');
const fromBob = bob.insert(5, 'bread\n');

// ...can be delivered in any order, any number of times, as objects, JSON or bytes.
if (fromBob) alice.apply(decodeOperation(encodeOperation(fromBob)));
if (fromAlice) {
  bob.apply(fromAlice);
  bob.apply(fromAlice); // returns 'duplicate'
}

alice.toString() === bob.toString(); // true: "milk\neggs\nbread\n"

if (alice.toString() !== bob.toString() || bob.toString() !== 'milk\neggs\nbread\n') {
  throw new Error(`quick start diverged: ${JSON.stringify([alice.toString(), bob.toString()])}`);
}
console.log(`quick start: ${JSON.stringify(alice.toString())}`);
