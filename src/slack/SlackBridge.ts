import { App, LogLevel } from '@slack/bolt';
import type { Workspace } from '../core/Workspace.ts';
import type { Logger } from '../core/Logger.ts';
import { SandboxRunner } from '../core/SandboxRunner.ts';
import { ThreadRouter } from './ThreadRouter.ts';
import { TurnQueue } from './TurnQueue.ts';
import { SlackRenderer } from './SlackRenderer.ts';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Optional allow-list of channel ids. Empty = respond anywhere the bot is present. */
  channels?: string[];
  maxConcurrent?: number;
  idleReapMinutes?: number;
}

const WORKING = 'hourglass_flowing_sand';
const DONE = 'white_check_mark';
const FAILED = 'x';

/**
 * Bridges Slack to sandboxed agent turns.
 *
 * Design notes that are easy to get wrong:
 *  - Slack redelivers events; we ack immediately and drop retries, edits and our own messages,
 *    otherwise one question is answered several times.
 *  - A follow-up in a thread usually has no @mention, so plain `message` events are accepted
 *    when their `thread_ts` is already in the registry.
 *  - Turns for one thread are serialised; the session file cannot take concurrent writers.
 */
export class SlackBridge {
  private readonly app: App;
  private readonly router: ThreadRouter;
  private readonly queue: TurnQueue;
  private readonly runner: SandboxRunner;
  private readonly renderer = new SlackRenderer();
  private readonly seenEvents = new Set<string>();
  private reaper?: ReturnType<typeof setInterval>;

  constructor(
    private readonly workspace: Workspace,
    private readonly log: Logger,
    private readonly config: SlackConfig,
  ) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
    this.router = new ThreadRouter(workspace);
    this.queue = new TurnQueue(config.maxConcurrent ?? 4);
    this.runner = new SandboxRunner(workspace, log);
    this.register();
  }

  private register(): void {
    // Direct mention — always ours.
    this.app.event('app_mention', async ({ event, client, body }) => {
      if (this.isDuplicate((body as { event_id?: string }).event_id)) return;
      await this.handle({
        client,
        team: (body as { team_id?: string }).team_id ?? 'unknown',
        channel: event.channel,
        user: event.user ?? 'unknown',
        messageTs: event.ts,
        threadTs: (event as { thread_ts?: string }).thread_ts ?? event.ts,
        text: this.stripMention(event.text ?? ''),
      });
    });

    // Follow-ups and DMs: no mention required, but only in threads we already own (or a DM).
    this.app.event('message', async ({ event, client, body }) => {
      const m = event as {
        subtype?: string; bot_id?: string; user?: string; text?: string;
        channel?: string; channel_type?: string; ts?: string; thread_ts?: string;
      };
      if (m.subtype || m.bot_id || !m.user || !m.text || !m.channel || !m.ts) return; // edits, joins, our own posts
      if (this.isDuplicate((body as { event_id?: string }).event_id)) return;

      const team = (body as { team_id?: string }).team_id ?? 'unknown';
      const threadTs = m.thread_ts ?? m.ts;
      const isDm = m.channel_type === 'im';
      const isKnownThread = Boolean(m.thread_ts) && this.router.isKnownThread(team, m.channel, threadTs);
      if (!isDm && !isKnownThread) return; // a random channel message is not for us

      await this.handle({
        client, team, channel: m.channel, user: m.user,
        messageTs: m.ts, threadTs, text: m.text,
      });
    });

    this.app.action(/^brain_feedback_(up|down)$/, async ({ ack, body, action }) => {
      await ack();
      const vote = (action as { action_id: string }).action_id.endsWith('up') ? '👍' : '👎';
      this.log.info(`feedback ${vote} from ${(body as { user?: { id?: string } }).user?.id ?? 'unknown'}`);
    });
  }

  /** Slack retries deliveries; answering twice is the classic bug. */
  private isDuplicate(eventId?: string): boolean {
    if (!eventId) return false;
    if (this.seenEvents.has(eventId)) return true;
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > 1000) {
      for (const id of [...this.seenEvents].slice(0, 500)) this.seenEvents.delete(id);
    }
    return false;
  }

  private stripMention(text: string): string {
    return text.replace(/<@[UW][A-Z0-9]+>/g, '').trim();
  }

  private async handle(ctx: {
    client: App['client']; team: string; channel: string; user: string;
    messageTs: string; threadTs: string; text: string;
  }): Promise<void> {
    if (this.config.channels?.length && !this.config.channels.includes(ctx.channel)) return;
    if (!ctx.text) return;

    const react = async (name: string, remove = false) => {
      try {
        await (remove
          ? ctx.client.reactions.remove({ channel: ctx.channel, timestamp: ctx.messageTs, name })
          : ctx.client.reactions.add({ channel: ctx.channel, timestamp: ctx.messageTs, name }));
      } catch { /* already reacted, or missing scope — never fail a turn over an emoji */ }
    };

    await react(WORKING);
    const { record, isFollowUp } = this.router.resolve(ctx.team, ctx.channel, ctx.threadTs);

    const position = this.queue.positionFor(record.threadKey);
    if (position.ahead > 0) {
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: `Queued — ${position.ahead} ${position.ahead === 1 ? 'question' : 'questions'} ahead of this one.`,
      });
    }

    const startedAt = Date.now();
    try {
      const result = await this.queue.submit({
        threadKey: record.threadKey,
        run: () => this.runner.ask(ctx.text, {
          workspace: 'thread',
          sandboxName: record.sandbox,
          volumeName: record.volume,
          sessionDir: record.sessionDir,
          continueSession: isFollowUp,
        }),
      });

      const rendered = this.renderer.render(result.text, {
        tools: result.tools, elapsedMs: Date.now() - startedAt, threadKey: record.threadKey,
      });
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: rendered.fallbackText, blocks: rendered.blocks as never,
      });
      if (rendered.overflow) {
        await ctx.client.files.uploadV2({
          channel_id: ctx.channel, thread_ts: ctx.threadTs,
          filename: 'answer.md', content: rendered.overflow, title: 'Full answer',
        });
      }
      this.router.recordTurn(record.threadKey);
      await react(WORKING, true);
      await react(DONE);
    } catch (error) {
      const rendered = this.renderer.error((error as Error).message);
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: rendered.fallbackText, blocks: rendered.blocks as never,
      });
      await react(WORKING, true);
      await react(FAILED);
      this.log.fail(`turn failed for ${record.threadKey}: ${(error as Error).message}`);
    }
  }

  /** Stops containers for threads idle beyond the cutoff; volumes (and memory) survive. */
  private startReaper(): void {
    const minutes = this.config.idleReapMinutes ?? 15;
    this.reaper = setInterval(() => {
      for (const record of this.router.idleSince(minutes)) {
        if (!this.runner.isContainerRunning(record.sandbox)) continue;
        this.runner.stopContainer(record.sandbox);
        this.log.info(`reaped idle sandbox ${record.sandbox} (volume kept)`);
      }
    }, 60_000);
  }

  async start(): Promise<void> {
    await this.app.start();
    this.startReaper();
    this.log.ok('Slack bridge connected (Socket Mode)');
    this.log.info(`threads known: ${this.router.all().length} · concurrency: ${this.config.maxConcurrent ?? 4}`);
  }

  async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await this.app.stop();
  }
}
