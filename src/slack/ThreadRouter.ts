import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Workspace } from '../core/Workspace.ts';

export interface ThreadRecord {
  threadKey: string;
  team: string;
  channel: string;
  threadTs: string;
  sandbox: string;
  volume: string;
  /** Session directory *inside* the container. `--continue` resumes from here. */
  sessionDir: string;
  createdAt: string;
  lastTurnAt: string;
  turns: number;
  /**
   * True when unmentioned replies in this thread are meant for the bot.
   *
   * Set when the conversation *starts* with the bot — an @mention on a top-level
   * message, or a DM. An @mention posted as a reply inside a pre-existing human
   * thread answers that one message but does NOT adopt the thread, otherwise the
   * bot would answer every subsequent human reply in a conversation that was
   * never addressed to it.
   */
  adopted: boolean;
}

/**
 * Maps a Slack thread to a sandbox, a volume and a session directory, and remembers the mapping.
 *
 * The registry must outlive the bridge process: after a restart we still have to know that a
 * message in an existing thread is a *follow-up*, not a new conversation. Without it, every
 * restart would silently lose thread memory.
 */
export class ThreadRouter {
  private readonly path: string;
  private records = new Map<string, ThreadRecord>();

  constructor(private readonly workspace: Workspace, registryPath?: string) {
    this.path = registryPath ?? join(workspace.root, 'data', 'slack', 'threads.json');
    this.load();
  }

  static key(team: string, channel: string, threadTs: string): string {
    return `${team}:${channel}:${threadTs}`;
  }

  /** Slack ids are safe for names, but timestamps contain a dot Docker will not accept. */
  private static sanitise(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '-');
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as ThreadRecord[];
      this.records = new Map(raw.map((r) => [r.threadKey, r]));
    } catch {
      this.records = new Map(); // a corrupt registry must not stop the bridge from starting
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(tmp, this.path); // atomic: a crash mid-write must not truncate the registry
  }

  /**
   * True when an unmentioned message in this thread should be treated as a follow-up.
   *
   * Deliberately false for threads the bot was merely mentioned in — see `adopted`.
   * Records written before `adopted` existed are treated as adopted, which matches
   * how they behaved when they were created.
   */
  isKnownThread(team: string, channel: string, threadTs: string): boolean {
    const record = this.records.get(ThreadRouter.key(team, channel, threadTs));
    return record !== undefined && record.adopted !== false;
  }

  get(team: string, channel: string, threadTs: string): ThreadRecord | undefined {
    return this.records.get(ThreadRouter.key(team, channel, threadTs));
  }

  /**
   * Returns the existing record, or creates one. `isFollowUp` decides whether to pass `--continue`.
   *
   * `adopt` only ever upgrades: a thread that was adopted stays adopted, so a later
   * in-thread mention cannot silently un-own a conversation the bot started.
   */
  resolve(
    team: string,
    channel: string,
    threadTs: string,
    adopt = true,
  ): { record: ThreadRecord; isFollowUp: boolean } {
    const key = ThreadRouter.key(team, channel, threadTs);
    const existing = this.records.get(key);
    if (existing) {
      if (adopt && existing.adopted === false) { existing.adopted = true; this.persist(); }
      return { record: existing, isFollowUp: existing.turns > 0 };
    }

    const slug = `${ThreadRouter.sanitise(team)}-${ThreadRouter.sanitise(channel)}-${ThreadRouter.sanitise(threadTs)}`;
    const now = new Date().toISOString();
    const record: ThreadRecord = {
      threadKey: key, team, channel, threadTs,
      sandbox: `brain-thread-${slug}`.toLowerCase(),
      volume: `brain-ws-thread-${slug}`.toLowerCase(),
      sessionDir: `/workspace/sessions/${ThreadRouter.sanitise(threadTs)}`,
      createdAt: now, lastTurnAt: now, turns: 0, adopted: adopt,
    };
    this.records.set(key, record);
    this.persist();
    return { record, isFollowUp: false };
  }

  recordTurn(threadKey: string): void {
    const record = this.records.get(threadKey);
    if (!record) return;
    record.turns += 1;
    record.lastTurnAt = new Date().toISOString();
    this.persist();
  }

  /** Threads whose last turn is older than the cutoff — candidates for container reaping. */
  idleSince(minutes: number): ThreadRecord[] {
    const cutoff = Date.now() - minutes * 60_000;
    return [...this.records.values()].filter((r) => Date.parse(r.lastTurnAt) < cutoff);
  }

  /** Drops a thread from the registry so unmentioned replies in it are ignored again. */
  forget(threadKey: string): boolean {
    if (!this.records.delete(threadKey)) return false;
    this.persist();
    return true;
  }

  all(): ThreadRecord[] { return [...this.records.values()]; }
}
