import { App, LogLevel } from '@slack/bolt';
import type { Workspace } from '../core/Workspace.ts';
import type { Logger } from '../core/Logger.ts';
import { SandboxRunner } from '../core/SandboxRunner.ts';
import { ThreadRouter } from './ThreadRouter.ts';
import { TurnQueue } from './TurnQueue.ts';
import { SlackRenderer } from './SlackRenderer.ts';
import { ReverseApproval } from '../core/ReverseApproval.ts';

/**
 * Message subtypes that still represent a person saying something new.
 * Everything else (message_changed, message_deleted, channel_join, bot_message, …)
 * is either not new text or not from a human.
 */
const ANSWERABLE_SUBTYPES = new Set(['file_share', 'thread_broadcast', 'me_message']);

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Optional allow-list of channel ids. Empty = respond anywhere the bot is present. */
  channels?: string[];
  maxConcurrent?: number;
  idleReapMinutes?: number;
  /**
   * Slack user ids permitted to approve an external write. Empty means anyone who can see
   * the card can spend the approval — fine for a single-operator demo, wrong for a shared
   * channel, so it is stated explicitly rather than left implicit.
   */
  approvers?: string[];
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
  /** Holds reverse-ETL approval tokens on the host — never in Slack, never in the sandbox. */
  private readonly approvals: ReverseApproval;
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
    this.approvals = new ReverseApproval(workspace, log);
    this.register();
  }

  private register(): void {
    // Direct mention — always ours.
    this.app.event('app_mention', async ({ event, client, body, context }) => {
      const e = event as { bot_id?: string; bot_profile?: unknown; thread_ts?: string };
      // Slack delivers bot-authored mentions too (a workflow or another app naming us).
      // Bolt's ignoreSelf cannot filter these: its bot branch only runs for events that
      // carry a `message` alias, which app_mention never does. Without this, one app
      // mentioning another can trade turns indefinitely.
      if (e.bot_id || e.bot_profile) return;
      if (this.isDuplicate((body as { event_id?: string }).event_id)) return;

      // Adopt the thread only when the conversation starts with us. A mention posted as
      // a reply inside a pre-existing human thread gets answered, but must not turn every
      // later human reply in that thread into a sandboxed turn.
      const startsConversation = !e.thread_ts || e.thread_ts === event.ts;

      await this.handle({
        client,
        team: this.teamOf(body),
        channel: event.channel,
        user: event.user ?? 'unknown',
        messageTs: event.ts,
        threadTs: e.thread_ts ?? event.ts,
        text: this.stripMention(event.text ?? '', context.botUserId),
        adopt: startsConversation,
      });
    });

    // Follow-ups and DMs: no mention required, but only in threads we already own (or a DM).
    this.app.event('message', async ({ event, client, body, context }) => {
      const m = event as {
        subtype?: string; bot_id?: string; user?: string; text?: string;
        channel?: string; channel_type?: string; ts?: string; thread_ts?: string;
      };
      if (m.bot_id || !m.user || !m.text || !m.channel || !m.ts) return; // our own posts, joins
      // Only reject subtypes that are not real new messages. A blanket `m.subtype` reject
      // also discarded file_share, thread_broadcast and me_message, which carry everything
      // a turn needs and read to the user as ordinary follow-ups.
      if (m.subtype && !ANSWERABLE_SUBTYPES.has(m.subtype)) return;

      // An @mention in a channel is delivered as BOTH app_mention and message.*, with the
      // same message ts. app_mention owns it — it is the path that strips the mention —
      // so drop it here. Testing the text is deterministic; an event_id or ts cache is not,
      // because either event can arrive first.
      if (context.botUserId && m.text.includes(`<@${context.botUserId}>`)) return;

      const team = this.teamOf(body);
      const threadTs = m.thread_ts ?? m.ts;
      const isDm = m.channel_type === 'im';
      const isKnownThread = Boolean(m.thread_ts) && this.router.isKnownThread(team, m.channel, threadTs);
      if (!isDm && !isKnownThread) return; // a random channel message is not for us

      // Dedupe only what we are actually going to answer: checking earlier let ordinary
      // channel chatter evict real ids from the bounded cache, after which a genuine
      // Slack retry would be answered twice.
      if (this.isDuplicate((body as { event_id?: string }).event_id)) return;

      await this.handle({
        client, team, channel: m.channel, user: m.user,
        messageTs: m.ts, threadTs, text: m.text, isDm,
      });
    });

    this.app.action('brain_reverse_approve', async ({ ack, body, action, client }) => {
      await ack();
      const planId = (action as { value?: string }).value ?? '';
      const who = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
      const container = (body as { channel?: { id?: string } }).channel?.id ?? '';
      const thread = (body as { message?: { thread_ts?: string; ts?: string } }).message;
      const post = (text: string) => client.chat.postMessage({
        channel: container, thread_ts: thread?.thread_ts ?? thread?.ts, text,
      });

      const allowed = this.config.approvers ?? [];
      if (allowed.length > 0 && !allowed.includes(who)) {
        await post(`:no_entry: <@${who}> is not on the approver list for external writes.`);
        this.log.warn(`refused an approval from ${who} for ${planId}`);
        return;
      }
      if (!this.approvals.pending(planId)) { await post(`:warning: <@${who}> that approval is no longer pending.`); return; }
      await post(`:hourglass_flowing_sand: Approved by <@${who}> — writing now.`);
      const result = this.approvals.approve(planId, who);
      await post(result.ok ? `:white_check_mark: ${result.message}.` : `:x: The write failed — ${result.message}`);
    });

    this.app.action('brain_reverse_reject', async ({ ack, body, action, client }) => {
      await ack();
      const planId = (action as { value?: string }).value ?? '';
      const who = (body as { user?: { id?: string } }).user?.id ?? 'unknown';
      const channel = (body as { channel?: { id?: string } }).channel?.id ?? '';
      const thread = (body as { message?: { thread_ts?: string; ts?: string } }).message;
      const mayReject = this.config.approvers ?? [];
      if (mayReject.length > 0 && !mayReject.includes(who)) {
        await client.chat.postMessage({
          channel, thread_ts: thread?.thread_ts ?? thread?.ts,
          text: `:no_entry: <@${who}> is not on the approver list.`,
        });
        return;
      }
      this.approvals.reject(planId);
      await client.chat.postMessage({
        channel, thread_ts: thread?.thread_ts ?? thread?.ts,
        text: `:no_entry: Rejected by <@${who}>. Nothing was written and the approval is discarded.`,
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

  /**
   * Slack puts team_id at the envelope root for classic events, but org-wide installs
   * carry it only under authorizations[]. Falling back to the literal 'unknown' would
   * bake that string into the thread key, so every thread in the workspace would
   * collide on one key.
   */
  private teamOf(body: unknown): string {
    const b = body as {
      team_id?: string;
      authorizations?: Array<{ team_id?: string; enterprise_id?: string }>;
    };
    const team = b.team_id ?? b.authorizations?.[0]?.team_id ?? b.authorizations?.[0]?.enterprise_id;
    if (!team) this.log.warn('event carried no team_id — thread keys may collide');
    return team ?? 'unknown';
  }

  /**
   * Removes only our own mention. Stripping every `<@U…>` deleted the mentions of the
   * people the question was about ("what did <@U123> ship?" lost its subject).
   */
  private stripMention(text: string, botUserId?: string): string {
    const withoutSelf = botUserId
      ? text.replace(new RegExp(`<@${botUserId}>`, 'g'), '')
      : text.replace(/<@[UW][A-Z0-9]+>/g, '');
    return withoutSelf.trim();
  }

  private async handle(ctx: {
    client: App['client']; team: string; channel: string; user: string;
    messageTs: string; threadTs: string; text: string;
    /** DMs are a conversation with the bot by definition, so the allow-list must not apply. */
    isDm?: boolean;
    /** False for a mention inside a pre-existing human thread — answer it, do not own it. */
    adopt?: boolean;
  }): Promise<void> {
    // SLACK_CHANNELS scopes *channels*. Applying it to a DM compared against a D… id that
    // can never be in the list, which silently switched every DM off.
    if (this.config.channels?.length && !ctx.isDm && !this.config.channels.includes(ctx.channel)) {
      this.log.info(`ignoring ${ctx.channel} — not in SLACK_CHANNELS`);
      return;
    }

    const react = async (name: string, remove = false) => {
      try {
        await (remove
          ? ctx.client.reactions.remove({ channel: ctx.channel, timestamp: ctx.messageTs, name })
          : ctx.client.reactions.add({ channel: ctx.channel, timestamp: ctx.messageTs, name }));
      } catch { /* already reacted, or missing scope — never fail a turn over an emoji */ }
    };

    // Registered before the empty-text check on purpose. A bare "@Company Brain" used to
    // return here without creating a record, so the thread it opened was never recognised
    // and every follow-up under it was dropped as unknown — a silent dead end.
    const { record, isFollowUp } = this.router.resolve(
      ctx.team, ctx.channel, ctx.threadTs, ctx.adopt ?? true,
    );

    if (!ctx.text) {
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: 'Ask me a question in this thread — you do not need to mention me again.',
      });
      return;
    }

    await react(WORKING);

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
        // The answer is already posted. A failed attachment (missing files:write, size
        // limits) must degrade, not throw — throwing here would land in the catch below
        // and report a successful turn as failed.
        try {
          await ctx.client.files.uploadV2({
            channel_id: ctx.channel, thread_ts: ctx.threadTs,
            filename: 'answer.md', content: rendered.overflow, title: 'Full answer',
          });
        } catch (uploadError) {
          this.log.warn(`could not attach the full answer: ${(uploadError as Error).message}`);
          await ctx.client.chat.postMessage({
            channel: ctx.channel, thread_ts: ctx.threadTs,
            text: '_The full answer could not be attached — the text above is truncated._',
          });
        }
      }
      this.router.recordTurn(record.threadKey);
      await react(WORKING, true);
      await react(DONE);

      // The agent cannot sync (no pm in the sandbox, /warehouse is read-only, no
      // credentials). If it decided data was missing but extractable, it left a request
      // on the shared volume; run it here, on the host, and report back in-thread.
      await this.runPendingSyncRequest(ctx, record.sandbox);
      await this.runPendingReverseRequest(ctx, record.sandbox);
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
      const busy = this.queue.busyThreadKeys;
      for (const record of this.router.idleSince(minutes)) {
        // lastTurnAt is stamped on COMPLETION, so a long-running turn reads as idle.
        // Removing its container mid-turn would hang the turn for the full timeout.
        if (busy.has(record.threadKey)) continue;
        if (!this.runner.isContainerRunning(record.sandbox)) continue;
        this.runner.stopContainer(record.sandbox);
        this.log.info(`reaped idle sandbox ${record.sandbox} (volume kept)`);
      }
    }, 60_000);
  }

  /**
   * Executes a sync the agent requested during its turn, and says so in the thread.
   *
   * Reported rather than silent: a first extraction takes real time, and a user who is
   * told "I have requested it" needs to see it land.
   */
  private async runPendingSyncRequest(
    ctx: { client: App['client']; channel: string; threadTs: string },
    container: string,
  ): Promise<void> {
    const REQUEST = '/workspace/requests/sync.json';
    const raw = this.runner.readFile(container, REQUEST).trim();
    if (!raw) return;
    this.runner.exec(container, ['rm', '-f', REQUEST]); // one request per turn, never replayed

    let request: { connector?: string; connection?: string; streams?: string[]; reason?: string };
    try { request = JSON.parse(raw); }
    catch { this.log.warn(`ignored an unparseable sync request: ${raw.slice(0, 120)}`); return; }

    const streams = (request.streams ?? []).join(', ') || 'the requested data';
    await ctx.client.chat.postMessage({
      channel: ctx.channel, thread_ts: ctx.threadTs,
      text: `:hourglass_flowing_sand: Extracting ${streams} — this usually takes a minute. I will post here when it lands.`,
    });

    try {
      const { PmBinary } = await import('../core/PmBinary.ts');
      const { PmProject } = await import('../core/PmProject.ts');
      const { SyncRequestRunner } = await import('../core/SyncRequest.ts');
      const pm = new PmBinary(this.workspace, this.log);
      const project = new PmProject(pm, this.workspace, this.log);
      const outcome = new SyncRequestRunner(this.workspace, pm, project, this.log).run(request);

      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: outcome.ok
          ? `:white_check_mark: ${outcome.message}. Ask again and I will use it.`
          : `:x: Could not extract it — ${outcome.message}`,
      });
    } catch (error) {
      this.log.fail(`sync request failed: ${(error as Error).message}`);
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: `:x: The extraction failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Turns a write the agent proposed into an approval card.
   *
   * The agent cannot approve its own mutation — pm omits the token from --json for exactly
   * that reason. So it writes an intent, the host plans it (human-readable, which is the
   * only output carrying the token), and a person presses Approve here.
   */
  private async runPendingReverseRequest(
    ctx: { client: App['client']; channel: string; threadTs: string },
    container: string,
  ): Promise<void> {
    const REQUEST = '/workspace/requests/reverse.json';
    const raw = this.runner.readFile(container, REQUEST).trim();
    if (!raw) return;
    this.runner.exec(container, ['rm', '-f', REQUEST]);

    let intent: { sourceTable?: string; destination?: string; map?: Record<string, string>; reason?: string };
    try { intent = JSON.parse(raw); }
    catch { this.log.warn(`ignored an unparseable reverse request: ${raw.slice(0, 120)}`); return; }

    if (!intent.sourceTable || !intent.destination || !intent.map) {
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: ':x: The proposed write was incomplete — it needs sourceTable, destination and map.',
      });
      return;
    }

    const prepared = this.approvals.prepare({
      sourceTable: intent.sourceTable,
      destination: intent.destination,
      map: intent.map,
      reason: intent.reason,
    });

    if (!prepared.ok) {
      await ctx.client.chat.postMessage({
        channel: ctx.channel, thread_ts: ctx.threadTs,
        text: `:x: Could not plan that write — ${prepared.error}`,
      });
      return;
    }

    const plan = prepared.plan;
    const mapping = Object.entries(plan.mappings).map(([from, to]) => `\`${from}\` → \`${to}\``).join(', ');
    const sample = plan.sample.slice(0, 3).map((row) => `• ${SlackRenderer.escape(JSON.stringify(row).slice(0, 180))}`).join('\n');

    await ctx.client.chat.postMessage({
      channel: ctx.channel, thread_ts: ctx.threadTs,
      text: `Approval needed: write ${plan.recordCount} record(s) to ${plan.destination}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Approval needed — this writes to an external system.*\n`
              + `*${plan.recordCount}* record(s) from \`${plan.sourceTable}\` → *${plan.destination}*\n`
              + `Mapping: ${mapping}`
              + (intent.reason ? `\nReason: ${SlackRenderer.escape(intent.reason)}` : ''),
          },
        },
        ...(sample ? [{ type: 'section', text: { type: 'mrkdwn', text: `Sample:\n${sample}` } }] : []),
        {
          type: 'actions',
          block_id: `brain_reverse:${plan.planId}`,
          elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'brain_reverse_approve', value: plan.planId },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'brain_reverse_reject', value: plan.planId },
          ],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `plan \`${plan.planId}\`${plan.expiresAt ? ` · expires ${plan.expiresAt}` : ''} · nothing is written until someone approves` }],
        },
      ] as never,
    });
  }

  async start(): Promise<void> {
    // Build the image BEFORE opening the socket. SandboxRunner.start() is synchronous
    // and Node is single-threaded, so a cold first turn would run `docker build` on the
    // event loop for minutes — long enough that socket-mode's ping/pong timers stop
    // firing and the websocket is torn down and reconnected, losing in-flight events.
    // Paying for it up front costs nothing at rest and removes the worst-case stall.
    this.runner.assertDocker();
    if (!this.runner.imageExists()) {
      this.log.step('Sandbox image missing — building it before connecting');
      this.runner.buildImage();
    }

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
