import { spawnSync } from 'node:child_process';
import type { Workspace } from './Workspace.ts';
import type { Logger } from './Logger.ts';

/**
 * Holds reverse-ETL approval on the host, so a human in Slack can authorise a write the
 * agent proposed but must not perform.
 *
 * pm splits this deliberately — from `pm reverse --help`: "Agents can create and preview
 * plans, but JSON plan output omits approval tokens so an agent cannot silently approve its
 * own external mutation." Verified: `pm reverse plan` prints `Approval token: …` in
 * human-readable output and omits the line under `--json`; `pm reverse run` without a token
 * fails with "reverse run requires --approval-token-stdin", and with a guessed one fails
 * with "approval token is invalid".
 *
 * So the split is honoured rather than worked around: the sandboxed agent proposes an
 * intent, the HOST runs the plan in human-readable mode and keeps the token in memory, and
 * the token is spent only when a person presses Approve in Slack. The token is never
 * written to disk, never sent to Slack, and never enters the sandbox.
 */

/** A bulk write: warehouse rows mapped through a connector write action. */
export interface ReverseIntent {
  kind?: 'reverse';
  name?: string;
  sourceTable: string;
  destination: string;      // connector:credential
  map: Record<string, string>;
  reason?: string;
}

/**
 * A single connector command — `pm github issue create`, `pm github issue delete`.
 *
 * Kept separate from ReverseIntent because the two have different plan/run shapes:
 * a reverse plan is executed with `pm reverse run <id>`, a command plan by re-invoking
 * the same command with `--plan <id>`. Verified against both today.
 */
export interface CommandIntent {
  kind: 'command';
  connector: string;
  command: string[];            // e.g. ['issue','create']
  flags?: Record<string, string>;
  credential?: string;
  config?: Record<string, string>;
  reason?: string;
}

export type WriteIntent = ReverseIntent | CommandIntent;

export interface PreparedPlan {
  planId: string;
  name: string;
  /** How it must be executed — the two paths are not interchangeable. */
  kind: 'reverse' | 'command';
  /** Human-readable description of the operation, for the Slack card. */
  summary: string;
  /** Set for kind='command': the argv needed to execute, minus plan/token flags. */
  argv?: string[];
  /**
   * True when pm refused to issue a token at plan time and demanded a preview.
   * Those plans additionally require `--confirm destructive` at execution.
   */
  destructive: boolean;
  sourceTable?: string;
  destination?: string;
  recordCount?: number;
  mappings?: Record<string, string>;
  sample?: Array<Record<string, unknown>>;
  expiresAt?: string;
}

export interface RunResult {
  ok: boolean;
  message: string;
  written?: number;
  failed?: number;
}

interface Held { token: string; plan: PreparedPlan; heldAt: number }

const TOKEN_LINE = /Approval token:\s*([A-Za-z0-9._-]+)/;

/**
 * The intent comes from model-generated JSON, and every field of it becomes an argv entry to
 * `pm`. Without validation a value like `--approval-token-stdin` or `-x` is not data — it is
 * a flag, and the agent would be writing the host command line rather than describing a
 * record. Validate before building argv, not after.
 */
const SAFE_TABLE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const SAFE_ENDPOINT = /^[a-z0-9][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_FIELD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A command intent is argv too, so the same rule applies: nothing may become a flag.
 * Flag VALUES are the exception — an issue title is free text and is passed as a
 * separate argv element, so it cannot split a pair. It must still not start with a dash.
 */
function rejectCommand(intent: CommandIntent): string | undefined {
  if (!SAFE_NAME.test(intent.connector)) return `connector "${intent.connector}" is not a plain name`;
  if (!Array.isArray(intent.command) || intent.command.length === 0) return 'no command was named';
  if (intent.command.length > 4) return 'command path is too deep';
  for (const part of intent.command) if (!SAFE_NAME.test(part)) return `command part "${part}" is not a plain name`;
  if (intent.credential !== undefined && !SAFE_NAME.test(intent.credential)) return 'credential is not a plain name';
  for (const [flag, value] of Object.entries(intent.flags ?? {})) {
    if (!SAFE_NAME.test(flag)) return `flag "${flag}" is not a plain flag name`;
    if (typeof value !== 'string') return `flag "${flag}" must be a string`;
    if (value.startsWith('-')) return `the value of "${flag}" may not begin with a dash`;
    if (value.length > 8000) return `the value of "${flag}" is too long`;
  }
  for (const [key, value] of Object.entries(intent.config ?? {})) {
    if (!SAFE_FIELD.test(key)) return `config key "${key}" is not a plain name`;
    if (typeof value !== 'string' || value.startsWith('-') || value.includes('=')) {
      return `config value for "${key}" is not a plain value`;
    }
  }
  return undefined;
}

function rejectIntent(intent: ReverseIntent): string | undefined {
  if (!SAFE_TABLE.test(intent.sourceTable)) {
    return `source table "${intent.sourceTable}" is not a plain table name`;
  }
  if (!SAFE_ENDPOINT.test(intent.destination)) {
    return `destination "${intent.destination}" must be connector:credential`;
  }
  const pairs = Object.entries(intent.map ?? {});
  if (pairs.length === 0) return 'the proposal mapped no fields';
  if (pairs.length > 64) return 'too many mapped fields';
  for (const [from, to] of pairs) {
    // A colon would split into the wrong pair; a leading dash would become a flag.
    if (!SAFE_FIELD.test(from)) return `source field "${from}" is not a plain field name`;
    if (!SAFE_FIELD.test(String(to))) return `destination field "${to}" is not a plain field name`;
  }
  if (intent.name !== undefined && !SAFE_FIELD.test(intent.name)) return 'plan name is not a plain name';
  return undefined;
}


export class ReverseApproval {
  /** planId -> token. In memory only: a restart should invalidate pending approvals. */
  private readonly held = new Map<string, Held>();

  constructor(private readonly workspace: Workspace, private readonly log: Logger) {}

  private pm(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(this.workspace.pmBinary, args, {
      cwd: this.workspace.pmProjectDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  /**
   * Plans the write and captures the approval token.
   *
   * Run WITHOUT --json on purpose: that is the only output that carries the token.
   */
  /** Routes to the right planner. Both end with a token held on the host. */
  prepare(intent: WriteIntent): { ok: true; plan: PreparedPlan } | { ok: false; error: string } {
    return intent.kind === 'command'
      ? this.prepareCommand(intent)
      : this.prepareReverse(intent as ReverseIntent);
  }

  /**
   * Plans a single connector command.
   *
   * Two token behaviours, both observed: an ordinary write prints `Approval token:` at plan
   * time, while a destructive one prints "Preview required before an approval token is
   * issued" and only yields the token from `--preview`, which performs the real dry run.
   * Those also demand `--confirm destructive` at execution.
   */
  private prepareCommand(intent: CommandIntent): { ok: true; plan: PreparedPlan } | { ok: false; error: string } {
    const rejected = rejectCommand(intent);
    if (rejected) return { ok: false, error: rejected };

    const argv: string[] = [intent.connector, ...intent.command];
    for (const [flag, value] of Object.entries(intent.flags ?? {})) argv.push(`--${flag}`, value);
    if (intent.credential) argv.push('--credential', intent.credential);
    for (const [key, value] of Object.entries(intent.config ?? {})) argv.push('--config', `${key}=${value}`);

    const planned = this.pm(argv);
    const out = `${planned.stdout}\n${planned.stderr}`;
    const planId = /rplan_[a-f0-9]+/.exec(out)?.[0];
    if (!planId) {
      return { ok: false, error: (planned.stderr || planned.stdout).trim().slice(0, 400) || 'pm reported no plan' };
    }

    let token = TOKEN_LINE.exec(out)?.[1];
    const destructive = !token && /preview required/i.test(out);

    if (destructive) {
      // The preview is a real no-network dry run; pm will not issue a token without it.
      const previewed = this.pm([...argv.slice(0, 1 + intent.command.length), '--plan', planId, '--preview']);
      token = TOKEN_LINE.exec(`${previewed.stdout}\n${previewed.stderr}`)?.[1];
      if (!token) {
        return { ok: false, error: (previewed.stderr || previewed.stdout).trim().slice(0, 400) || 'preview issued no token' };
      }
    }
    if (!token) return { ok: false, error: 'pm issued no approval token and did not ask for a preview' };

    const described = `${intent.connector} ${intent.command.join(' ')}`;
    const plan: PreparedPlan = {
      planId,
      name: described,
      kind: 'command',
      destructive,
      summary: described,
      // Only the command path is replayed; flags were consumed at plan time.
      argv: argv.slice(0, 1 + intent.command.length),
      mappings: intent.flags,
    };

    this.held.set(planId, { token, plan, heldAt: Date.now() });
    this.log.info(`held an approval for ${planId} (${described}${destructive ? ', destructive' : ''})`);
    return { ok: true, plan };
  }

  private prepareReverse(intent: ReverseIntent): { ok: true; plan: PreparedPlan } | { ok: false; error: string } {
    const rejected = rejectIntent(intent);
    if (rejected) return { ok: false, error: rejected };

    const name = intent.name ?? `slack-${Date.now().toString(36)}`;
    const args = [
      'reverse', 'plan', name,
      '--source-table', intent.sourceTable,
      '--destination', intent.destination,
    ];
    for (const [from, to] of Object.entries(intent.map)) args.push('--map', `${from}:${to}`);

    const planned = this.pm(args);
    if (planned.status !== 0) {
      return { ok: false, error: (planned.stderr || planned.stdout).trim().slice(0, 400) };
    }

    const token = TOKEN_LINE.exec(planned.stdout)?.[1];
    const planId = /rplan_[a-f0-9]+/.exec(planned.stdout)?.[0];
    if (!planId) return { ok: false, error: 'pm did not report a plan id' };
    if (!token) {
      return {
        ok: false,
        error: 'pm issued no approval token at plan time. Destructive plans only receive one '
          + 'from `pm reverse preview`, and may additionally require --confirm destructive.',
      };
    }

    // Detail for the Slack card comes from --json, which is safe to parse: no token in it.
    const detail = this.pm(['reverse', 'preview', planId, '--json']);
    let plan: PreparedPlan = {
      planId, name, kind: 'reverse', destructive: false,
      summary: `write rows from ${intent.sourceTable} to ${intent.destination}`,
      sourceTable: intent.sourceTable,
      destination: intent.destination,
      recordCount: 0,
      mappings: intent.map,
      sample: [],
    };
    try {
      const parsed = JSON.parse(detail.stdout) as { plan?: Record<string, unknown> };
      const p = parsed.plan ?? {};
      plan = {
        ...plan,
        recordCount: Number(p.record_count ?? 0),
        mappings: (p.mappings as Record<string, string>) ?? intent.map,
        sample: (p.sample as Array<Record<string, unknown>>) ?? [],
        expiresAt: typeof p.expires_at === 'string' ? p.expires_at : undefined,
      };
    } catch { /* the card degrades to the intent; the plan id is what matters */ }

    this.held.set(planId, { token, plan, heldAt: Date.now() });
    this.log.info(`held an approval for ${planId} (${plan.recordCount} records) — awaiting a human`);
    return { ok: true, plan };
  }

  pending(planId: string): PreparedPlan | undefined {
    return this.held.get(planId)?.plan;
  }

  /**
   * Spends the token. One approval, one execution: the entry is dropped either way.
   *
   * `confirmed` must be true for a destructive plan — it carries the human's typed
   * confirmation through from Slack to pm's `--confirm destructive`, so the typed gate is
   * answered by a person rather than manufactured here.
   */
  approve(planId: string, approvedBy: string, confirmed = false): RunResult {
    const entry = this.held.get(planId);
    if (!entry) return { ok: false, message: 'that approval is no longer pending — plan again' };
    if (entry.plan.destructive && !confirmed) {
      return { ok: false, message: 'this is a destructive operation and needs typed confirmation' };
    }
    this.held.delete(planId);

    const argv = entry.plan.kind === 'command'
      ? [...(entry.plan.argv ?? []), '--plan', planId, '--approval-token-stdin',
         ...(entry.plan.destructive ? ['--confirm', 'destructive'] : []), '--json']
      : ['reverse', 'run', planId, '--approval-token-stdin', '--json'];

    const result = spawnSync(
      this.workspace.pmBinary,
      argv,
      { cwd: this.workspace.pmProjectDir, encoding: 'utf8', input: `${entry.token}\n`, maxBuffer: 32 * 1024 * 1024 },
    );

    const raw = result.stdout ?? '';
    try {
      const parsed = JSON.parse(raw) as {
        run?: { status?: string; records_succeeded?: number; records_failed?: number };
        error?: { message?: string };
      };
      if (parsed.error?.message) return { ok: false, message: parsed.error.message };
      const run = parsed.run ?? {};
      const written = Number(run.records_succeeded ?? 0);
      const failed = Number(run.records_failed ?? 0);
      this.log.ok(`${planId} approved by ${approvedBy}: ${written} written, ${failed} failed`);
      return {
        ok: run.status === 'completed' && failed === 0,
        written, failed,
        message: `${written} record(s) written${failed ? `, ${failed} failed` : ''}`,
      };
    } catch {
      return { ok: false, message: (result.stderr || raw).trim().slice(0, 400) || 'pm produced no parseable result' };
    }
  }

  reject(planId: string): boolean {
    return this.held.delete(planId);
  }
}
