/**
 * Dispatches real-shaped Slack payloads through the real Bolt app.
 *
 * No test previously imported SlackBridge, so every guard in its listeners was
 * unexecuted — exactly the code that real event shapes break. Bolt's
 * `App.processEvent(event: ReceiverEvent)` is public and is the same call the
 * shipped SocketModeReceiver makes, so a payload can be driven straight into the
 * listeners with no websocket and no credentials.
 *
 * `fetch` is stubbed before the App is constructed: Bolt resolves botUserId by
 * calling auth.test on the first event, and an unstubbed call would hit the network.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackBridge } from '../src/slack/SlackBridge.ts';
import { Workspace } from '../src/core/Workspace.ts';
import { Logger } from '../src/core/Logger.ts';

const BOT_USER = 'U0BOT';
const TEAM = 'T1';
const CHANNEL = 'C1';

const realFetch = globalThis.fetch;

/** Slack Web API responses good enough for Bolt's auth and for the bridge's calls. */
function stubFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String((input as Request)?.url ?? input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? url;
    calls.push(method);
    const body: Record<string, unknown> =
      method === 'auth.test'
        ? { ok: true, user_id: BOT_USER, bot_id: 'B1', team_id: TEAM, url: 'https://x.slack.com/' }
        : { ok: true, ts: '1.1', channel: CHANNEL };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

interface Turn { question: string; sandbox?: string; continueSession?: boolean }

function makeBridge(channels: string[] = []): { bridge: SlackBridge; turns: Turn[] } {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), 'brain-evt-')));
  const bridge = new SlackBridge(ws, new Logger(true), {
    botToken: 'xoxb-test', appToken: 'xapp-test', channels,
  });
  const turns: Turn[] = [];
  // Replace the only side effect that would touch Docker.
  (bridge as unknown as { runner: { ask: unknown } }).runner.ask = async (
    question: string,
    options: { sandboxName?: string; continueSession?: boolean },
  ) => {
    turns.push({ question, sandbox: options.sandboxName, continueSession: options.continueSession });
    return { text: 'answer', tools: [] };
  };
  return { bridge, turns };
}

let restore: (() => void) | undefined;
beforeEach(() => { stubFetch(); });
afterEach(() => { globalThis.fetch = realFetch; restore?.(); restore = undefined; });

let eventSeq = 0;
async function dispatch(bridge: SlackBridge, event: Record<string, unknown>): Promise<void> {
  eventSeq += 1;
  const app = (bridge as unknown as { app: { processEvent: (e: unknown) => Promise<void> } }).app;
  await app.processEvent({
    body: { team_id: TEAM, event_id: `Ev${eventSeq}`, api_app_id: 'A1', type: 'event_callback', event },
    ack: async () => {},
  });
}

const mention = (ts: string, text: string, threadTs?: string) => ({
  type: 'app_mention', user: 'U1', channel: CHANNEL, ts, text, event_ts: ts,
  ...(threadTs ? { thread_ts: threadTs } : {}),
});

const said = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'message', user: 'U1', channel: CHANNEL, ts, text, event_ts: ts,
  channel_type: 'channel', ...extra,
});

test('a top-level @mention is answered and adopts the thread for follow-ups', async () => {
  const { bridge, turns } = makeBridge();
  await dispatch(bridge, mention('100.1', `<@${BOT_USER}> how many issues?`));
  expect(turns.length).toBe(1);
  expect(turns[0]!.question).toBe('how many issues?'); // our mention stripped

  // A plain reply in that thread needs no mention.
  await dispatch(bridge, said('100.2', 'and how many are open?', { thread_ts: '100.1' }));
  expect(turns.length).toBe(2);
  expect(turns[1]!.continueSession).toBe(true);
});

test('a mention inside a pre-existing human thread is answered but does NOT adopt it', async () => {
  const { bridge, turns } = makeBridge();
  // The thread already exists (parent 200.1); the mention is a reply at 200.5.
  await dispatch(bridge, mention('200.5', `<@${BOT_USER}> what changed?`, '200.1'));
  expect(turns.length).toBe(1);

  // Humans keep talking in their own thread — none of it is for the bot.
  await dispatch(bridge, said('200.6', 'anyway, lunch?', { thread_ts: '200.1' }));
  await dispatch(bridge, said('200.7', 'sounds good', { thread_ts: '200.1' }));
  expect(turns.length).toBe(1);
});

test('a bot-authored @mention is ignored, so two apps cannot trade turns', async () => {
  const { bridge, turns } = makeBridge();
  await dispatch(bridge, { ...mention('300.1', `<@${BOT_USER}> status?`), bot_id: 'BOTHER', user: undefined });
  expect(turns.length).toBe(0);
});

test('an @mention inside an owned thread produces exactly one turn, not two', async () => {
  const { bridge, turns } = makeBridge();
  await dispatch(bridge, mention('400.1', `<@${BOT_USER}> first`));
  expect(turns.length).toBe(1);

  // Slack delivers an in-thread mention as BOTH app_mention and message.channels.
  await dispatch(bridge, mention('400.2', `<@${BOT_USER}> second`, '400.1'));
  await dispatch(bridge, said('400.2', `<@${BOT_USER}> second`, { thread_ts: '400.1' }));
  expect(turns.length).toBe(2); // not 3
});

test('SLACK_CHANNELS scopes channels without switching DMs off', async () => {
  const { bridge, turns } = makeBridge(['C_ALLOWED']);
  await dispatch(bridge, mention('500.1', `<@${BOT_USER}> in a scoped-out channel`));
  expect(turns.length).toBe(0);

  await dispatch(bridge, said('500.2', 'a direct message', { channel: 'D9', channel_type: 'im' }));
  expect(turns.length).toBe(1);
});

test('a bare @mention still registers the thread, so the follow-up under it works', async () => {
  const { bridge, turns } = makeBridge();
  await dispatch(bridge, mention('600.1', `<@${BOT_USER}>`));
  expect(turns.length).toBe(0); // nothing to ask yet

  await dispatch(bridge, said('600.2', 'now the real question', { thread_ts: '600.1' }));
  expect(turns.length).toBe(1);
});

test('edits and joins are dropped, file_share is answered', async () => {
  const { bridge, turns } = makeBridge();
  await dispatch(bridge, mention('700.1', `<@${BOT_USER}> start`));
  expect(turns.length).toBe(1);

  await dispatch(bridge, said('700.2', 'edited', { thread_ts: '700.1', subtype: 'message_changed' }));
  await dispatch(bridge, said('700.3', 'joined', { thread_ts: '700.1', subtype: 'channel_join' }));
  expect(turns.length).toBe(1);

  await dispatch(bridge, said('700.4', 'here is a file', { thread_ts: '700.1', subtype: 'file_share' }));
  expect(turns.length).toBe(2);
});

test('mentions of other people survive; only ours is stripped', async () => {
  const { bridge, turns } = makeBridge();
  await dispatch(bridge, mention('800.1', `<@${BOT_USER}> what did <@U999> ship?`));
  expect(turns[0]!.question).toBe('what did <@U999> ship?');
});
