// Node.js 22.12+ can require() an ES module; the "default" export condition makes that resolve.
const { FugueText } = require('fugue-text');

const text = new FugueText({ replicaId: 'cjs' });
text.insert(0, 'ok');
if (text.toString() !== 'ok') throw new Error('require() returned a broken module');
console.log('require(): ok');
