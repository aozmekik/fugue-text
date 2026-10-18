import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  diff,
  TextareaBinding,
  type TextareaLike,
} from '../examples/broadcast-channel/textarea-binding.js';
import { connect } from '../examples/websocket-relay/client.js';
import { startRelay } from '../examples/websocket-relay/relay.js';
import { FugueText, FugueTextError } from '../src/index.js';
import type { Operation } from '../src/index.js';
import { numRuns } from './support/helpers.js';

/** Just enough of a <textarea> to drive the binding from tests. */
class FakeTextarea implements TextareaLike {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  readonly #listeners = new Set<() => void>();

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  addEventListener(_type: 'input', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'input', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  /** Replaces the selection with `text`, like typing or pasting. */
  type(text: string): void {
    const { value, selectionStart, selectionEnd } = this;
    this.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    this.selectionStart = this.selectionEnd = selectionStart + text.length;
    for (const listener of this.#listeners) listener();
  }
}

describe('textarea binding', () => {
  it('diff produces a splice that turns before into after', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.nat(), (before, after, caret) => {
        const { index, deleted, inserted } = diff(before, after, caret % (after.length + 1));
        expect(before.slice(0, index) + inserted + before.slice(index + deleted)).toBe(after);
      }),
      { numRuns },
    );
  });

  it('diff uses the caret to place repeated characters', () => {
    expect(diff('aa', 'aaa', 2)).toEqual({ index: 1, deleted: 0, inserted: 'a' });
    expect(diff('aa', 'aaa', 1)).toEqual({ index: 0, deleted: 0, inserted: 'a' });
    expect(diff('abc', 'aXc', 2)).toEqual({ index: 1, deleted: 1, inserted: 'X' });
  });

  it('syncs two textareas and keeps each caret in place', () => {
    const left = new FakeTextarea();
    const right = new FakeTextarea();
    const toRight: Operation[] = [];
    const toLeft: Operation[] = [];
    const leftBinding = new TextareaBinding(new FugueText({ replicaId: 'L' }), left, (op) =>
      toRight.push(op),
    );
    const rightBinding = new TextareaBinding(new FugueText({ replicaId: 'R' }), right, (op) =>
      toLeft.push(op),
    );
    const flush = (): void => {
      for (const op of toRight.splice(0)) rightBinding.receive(op);
      for (const op of toLeft.splice(0)) leftBinding.receive(op);
    };

    left.type('hello world');
    flush();
    expect(right.value).toBe('hello world');

    right.setSelectionRange(6, 6); // caret before "world"
    left.setSelectionRange(0, 0);
    left.type('>> ');
    flush();
    expect(right.value).toBe('>> hello world');
    expect(right.selectionStart).toBe(9); // still before "world"

    right.setSelectionRange(3, 8); // select "hello"
    left.setSelectionRange(0, 3);
    left.type(''); // delete ">> "
    flush();
    expect(right.value).toBe('hello world');
    expect([right.selectionStart, right.selectionEnd]).toEqual([0, 5]);

    leftBinding.destroy();
    left.type('ignored');
    expect(toRight).toEqual([]);
  });

  it('stays in sync when a remote operation is rejected', () => {
    const textarea = new FakeTextarea();
    const sent: Operation[] = [];
    const binding = new TextareaBinding(new FugueText({ replicaId: 'T' }), textarea, (op) =>
      sent.push(op),
    );
    textarea.type('abc');
    const orphan: Operation = {
      type: 'insert',
      replica: 'X',
      counter: 0,
      deps: {},
      parent: { replica: 'nobody', counter: 0 },
      side: 'right',
      text: '!',
    };
    expect(() => {
      binding.receive(orphan);
    }).toThrow(FugueTextError);
    expect(textarea.value).toBe('abc');
    textarea.type('d');
    expect(sent.map((op) => (op.type === 'insert' ? op.text : '-'))).toEqual(['abc', 'd']);
  });

  it('catches up from a merged state', () => {
    const source = new FugueText({ replicaId: 'S' });
    source.insert(0, 'shared state');
    const textarea = new FakeTextarea();
    const binding = new TextareaBinding(
      new FugueText({ replicaId: 'T' }),
      textarea,
      () => undefined,
    );
    binding.merge(source.save());
    expect(textarea.value).toBe('shared state');
  });
});

describe('websocket relay', () => {
  it('relays operations and serves late joiners', async () => {
    const relay = await startRelay(0);
    const url = `ws://127.0.0.1:${String(relay.port)}`;
    try {
      const alice = await connect(url, new FugueText({ replicaId: 'alice' }));
      const bob = await connect(url);
      alice.insert(0, 'abc');
      bob.insert(0, 'xyz');
      await Promise.all([alice.waitFor(bob.doc.version), bob.waitFor(alice.doc.version)]);
      expect(alice.doc.toString()).toBe(bob.doc.toString());
      alice.delete(0, 1);
      await bob.waitFor(alice.doc.version);
      const carol = await connect(url);
      await carol.waitFor(alice.doc.version);
      expect(carol.doc.toString()).toBe(alice.doc.toString());
      expect(relay.doc.toString()).toBe(alice.doc.toString());
      for (const client of [alice, bob, carol]) client.close();
    } finally {
      await relay.close();
    }
  });

  it('delivers edits made offline when a client reconnects', async () => {
    const relay = await startRelay(0);
    const url = `ws://127.0.0.1:${String(relay.port)}`;
    try {
      let alice = await connect(url);
      const bob = await connect(url);
      alice.insert(0, 'online ');
      await bob.waitFor(alice.doc.version);
      alice.close();
      alice.insert(alice.doc.length, 'offline'); // not sent: the socket is closed
      alice = await connect(url, alice.doc);
      await bob.waitFor(alice.doc.version);
      expect(bob.doc.toString()).toBe('online offline');
      for (const client of [alice, bob]) client.close();
    } finally {
      await relay.close();
    }
  });

  it('rebuilds a restarted relay from the clients', async () => {
    const first = await startRelay(0);
    let alice = await connect(`ws://127.0.0.1:${String(first.port)}`);
    let bob = await connect(`ws://127.0.0.1:${String(first.port)}`);
    alice.insert(0, 'kept across restarts');
    await bob.waitFor(alice.doc.version);
    await first.close();
    const second = await startRelay(0);
    const url = `ws://127.0.0.1:${String(second.port)}`;
    try {
      expect(second.doc.toString()).toBe('');
      [alice, bob] = await Promise.all([connect(url, alice.doc), connect(url, bob.doc)]);
      bob.insert(0, '> ');
      const carol = await connect(url);
      await carol.waitFor(bob.doc.version);
      expect(carol.doc.toString()).toBe('> kept across restarts');
      await alice.waitFor(bob.doc.version);
      expect(alice.doc.toString()).toBe(carol.doc.toString());
      for (const client of [alice, bob, carol]) client.close();
    } finally {
      await second.close();
    }
  });

  it('rejects a connection whose new document reuses an ID that already edited', async () => {
    const relay = await startRelay(0);
    const url = `ws://127.0.0.1:${String(relay.port)}`;
    try {
      const alice = await connect(url, new FugueText({ replicaId: 'alice' }));
      alice.insert(0, 'hello');
      const observer = await connect(url);
      await observer.waitFor(alice.doc.version);
      await expect(connect(url, new FugueText({ replicaId: 'alice' }))).rejects.toMatchObject({
        code: 'replica-conflict',
      });
      for (const client of [alice, observer]) client.close();
    } finally {
      await relay.close();
    }
  });

  it('disconnects clients that send invalid frames', async () => {
    const relay = await startRelay(0);
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${String(relay.port)}`);
      const closed = new Promise<number>((resolve) => {
        socket.addEventListener('close', (event) => {
          resolve(event.code);
        });
      });
      socket.addEventListener('open', () => {
        socket.send(Uint8Array.of(0x02, 0xff));
      });
      expect(await closed).toBe(1007);
    } finally {
      await relay.close();
    }
  });
});
