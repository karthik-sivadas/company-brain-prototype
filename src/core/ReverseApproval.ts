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

export interface ReverseIntent {
  name?: string;
  sourceTable: string;
  destination: string;      // connector:credential
  map: Record<string, string>;
  reason?: string;
}

export interface PreparedPlan {
  planId: string;
  name: string;
  sourceTable: string;
  destination: string;
  recordCount: number;
  mappings: Record<string, string>;
  sample: Array<Record<string, unknown>>;
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
  prepare(intent: ReverseIntent): { ok: true; plan: PreparedPlan } | { ok: false; error: string } {
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
      planId, name,
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

  /** Spends the token. One approval, one execution: the entry is dropped either way. */
  approve(planId: string, approvedBy: string): RunResult {
    const entry = this.held.get(planId);
    if (!entry) return { ok: false, message: 'that approval is no longer pending — plan again' };
    this.held.delete(planId);

    const result = spawnSync(
      this.workspace.pmBinary,
      ['reverse', 'run', planId, '--approval-token-stdin', '--json'],
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
