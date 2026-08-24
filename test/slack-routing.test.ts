import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThreadRouter } from '../src/slack/ThreadRouter.ts';
import { TurnQueue } from '../src/slack/TurnQueue.ts';
import { Workspace } from '../src/core/Workspace.ts';

const ws = new Workspace(mkdtempSync(join(tmpdir(), 'brain-test-')));
const registry = () => join(mkdtempSync(join(tmpdir(), 'brain-reg-')), 'threads.json');

test('a new thread gets docker-safe sandbox and volume names', () => {
  const r = new ThreadRouter(ws, registry());
  const { record, isFollowUp } = r.resolve('T123', 'C456', '1787573682.123456');
  expect(isFollowUp).toBe(false);
  // Slack timestamps contain a dot, which Docker rejects in names.
  expect(record.sandbox).not.toContain('.');
  expect(record.volume).not.toContain('.');
  expect(record.sandbox).toBe('brain-thread-t123-c456-1787573682-123456');
  expect(record.sessionDir).toBe('/workspace/sessions/1787573682-123456');
});

test('the second message in a thread is a follow-up, and survives a restart', () => {
  const path = registry();
  const first = new ThreadRouter(ws, path);
  const { record } = first.resolve('T1', 'C1', '111.222');
  expect(first.resolve('T1', 'C1', '111.222').isFollowUp).toBe(false); // no turn recorded yet
  first.recordTurn(record.threadKey);
  expect(first.resolve('T1', 'C1', '111.222').isFollowUp).toBe(true);

  // A bridge restart must not lose thread memory.
  const reloaded = new ThreadRouter(ws, path);
  expect(reloaded.isKnownThread('T1', 'C1', '111.222')).toBe(true);
  expect(reloaded.resolve('T1', 'C1', '111.222').isFollowUp).toBe(true);
  expect(reloaded.get('T1', 'C1', '111.222')?.turns).toBe(1);
});

test('unknown threads are not treated as follow-ups', () => {
  const r = new ThreadRouter(ws, registry());
  expect(r.isKnownThread('T1', 'C1', 'never-seen')).toBe(false);
});

test('idleSince finds stale threads for reaping', () => {
  const r = new ThreadRouter(ws, registry());
  const { record } = r.resolve('T1', 'C1', '999.000');
  expect(r.idleSince(15)).toHaveLength(0);
  record.lastTurnAt = new Date(Date.now() - 60 * 60_000).toISOString();
  expect(r.idleSince(15).map((x) => x.threadKey)).toContain(record.threadKey);
});

test('turns in one thread never run concurrently', async () => {
  const q = new TurnQueue(4);
  let concurrent = 0, peak = 0;
  const turn = () => q.submit({
    threadKey: 'same-thread',
    run: async () => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
    },
  });
  await Promise.all([turn(), turn(), turn()]);
  expect(peak).toBe(1); // serialised — otherwise the session file would interleave
});

test('different threads run in parallel up to the cap', async () => {
  const q = new TurnQueue(2);
  let concurrent = 0, peak = 0;
  const turn = (key: string) => q.submit({
    threadKey: key,
    run: async () => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 25));
      concurrent -= 1;
    },
  });
  await Promise.all([turn('a'), turn('b'), turn('c'), turn('d')]);
  expect(peak).toBe(2); // capped, not serialised
});

test('queue position reports how many turns are ahead', async () => {
  const q = new TurnQueue(1);
  expect(q.positionFor('x').ahead).toBe(0);

  // Deferred created up front: `submit` reaches `run()` only after a microtask, so capturing
  // the resolver inside the executor would race with the assertion below.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const held = q.submit({ threadKey: 'x', run: () => gate });
  await Promise.resolve();                      // let acquire() settle and run() start
  expect(q.positionFor('x').ahead).toBe(1);     // the running turn is ahead

  release();
  await held;
  expect(q.positionFor('x').ahead).toBe(0);
});
