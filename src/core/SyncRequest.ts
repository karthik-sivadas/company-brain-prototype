import { readFileSync, writeFileSync } from 'node:fs';
import type { Workspace, ConnectorSpec } from './Workspace.ts';
import type { PmBinary } from './PmBinary.ts';
import type { PmProject } from './PmProject.ts';
import type { Logger } from './Logger.ts';
import { SkillTransport } from './SkillTransport.ts';
import { DataState } from './DataState.ts';

/**
 * Runs an extraction the sandboxed agent asked for.
 *
 * The agent can see that a stream is missing but cannot pull it: `pm` is not installed in
 * the sandbox, /warehouse is read-only, and credentials deliberately never enter a
 * container. So it writes /workspace/requests/sync.json and the host acts on it once the
 * turn ends — which keeps the warehouse single-writer and the credentials on the host,
 * while still letting a question about un-synced data end in data rather than an apology.
 *
 * Deliberately narrow: only connectors already configured in brain.config.json, and only
 * streams pm declares for that connector. It can therefore add a *stream* but never a new
 * data source, and it never sees a credential it did not already have.
 */

export interface SyncRequest {
  connection?: string;
  connector?: string;
  streams?: string[];
  reason?: string;
}

export interface SyncRequestOutcome {
  ok: boolean;
  message: string;
  synced: Array<{ stream: string; rows: number }>;
}

export class SyncRequestRunner {
  constructor(
    private readonly workspace: Workspace,
    private readonly pm: PmBinary,
    private readonly project: PmProject,
    private readonly log: Logger,
  ) {}

  /**
   * Stream definitions pm declares for a connector.
   *
   * The primary key and cursor come from here rather than from a default: guessing "id"
   * for a GitHub stream produced `record is missing cursor field "undefined"`, because
   * pm declares node_id/updated_at and a connection built without them cannot dedupe.
   */
  private declaredStreams(connector: string): Map<string, { primaryKey?: string; cursor?: string }> {
    const out = this.pm.execTolerant<{
      manifest?: { streams?: Array<{ name?: string; primary_key?: string[]; cursor_fields?: string[] }> };
    }>(['connectors', 'inspect', connector]);
    const map = new Map<string, { primaryKey?: string; cursor?: string }>();
    for (const stream of out.envelope?.manifest?.streams ?? []) {
      if (!stream.name) continue;
      map.set(stream.name, {
        primaryKey: stream.primary_key?.[0],
        cursor: stream.cursor_fields?.[0],
      });
    }
    return map;
  }

  run(request: SyncRequest): SyncRequestOutcome {
    const config = this.workspace.loadConfig() as unknown as { connectors?: ConnectorSpec[] };
    const specs = config.connectors ?? [];
    const wanted = (request.streams ?? []).filter(Boolean);
    if (wanted.length === 0) return { ok: false, message: 'the request named no streams', synced: [] };

    // Match on connector name, or on any configured connection belonging to it.
    const hint = (request.connector ?? request.connection ?? '').toLowerCase();
    const spec = specs.find((s) => s.connector.toLowerCase() === hint)
      ?? specs.find((s) => hint.includes(s.connector.toLowerCase()))
      ?? (specs.length === 1 ? specs[0] : undefined);

    if (!spec) {
      return {
        ok: false,
        synced: [],
        message: `no configured connection matches "${request.connector ?? request.connection ?? ''}". `
          + `Configured: ${specs.map((s) => s.connector).join(', ') || 'none'}. `
          + 'Adding a new data source needs credentials and is a host change.',
      };
    }

    const declared = this.declaredStreams(spec.connector);
    const unknown = declared.size > 0 ? wanted.filter((s) => !declared.has(s)) : [];
    if (unknown.length > 0) {
      return {
        ok: false,
        synced: [],
        message: `${spec.connector} does not provide: ${unknown.join(', ')}. `
          + `It provides: ${[...declared.keys()].slice(0, 30).join(', ')}`,
      };
    }

    // Persist any newly requested stream so it stays synced from now on, rather than
    // being pulled once and silently going stale.
    const existing = new Set((spec.streams ?? []).map((s) => s.name));
    const added = wanted.filter((s) => !existing.has(s));
    if (added.length > 0) {
      spec.streams = [
        ...(spec.streams ?? []),
        ...added.map((name) => {
          const meta = declared.get(name) ?? {};
          return {
            name,
            primaryKey: meta.primaryKey ?? 'id',
            ...(meta.cursor ? { cursor: meta.cursor } : {}),
            table: `${spec.connector}_${name}`,
          };
        }),
      ];
      const raw = JSON.parse(readFileSync(this.workspace.configPath, 'utf8')) as Record<string, unknown>;
      raw.connectors = specs;
      writeFileSync(this.workspace.configPath, `${JSON.stringify(raw, null, 2)}\n`);
      this.log.info(`added stream(s) to brain.config.json: ${added.join(', ')}`);
    }

    // Always reconcile connections, not only when a stream is new: connect() is idempotent
    // and reports "already present", and a stream can be configured while its connection is
    // missing — which is exactly the state a previously failed request leaves behind.
    this.project.connect(spec);

    const target: ConnectorSpec = { ...spec, streams: (spec.streams ?? []).filter((s) => wanted.includes(s.name)) };
    const results = this.project.sync(target);

    const synced = results
      .filter((r) => !r.error || r.benignFailure)
      .map((r) => ({ stream: r.connection, rows: r.recordsLoaded }));
    const failed = results.filter((r) => r.error && !r.benignFailure);

    // The agent's map of the world must be regenerated or the next turn still thinks
    // the data is missing.
    const tables = this.project.listTables();
    new SkillTransport(this.pm, this.workspace, this.log).writeSearchSkill(tables);
    try { new DataState(this.workspace, this.pm, this.log).write(tables); } catch { /* advisory */ }

    if (failed.length > 0) {
      return {
        ok: false,
        synced,
        message: `sync failed for ${failed.map((f) => f.connection).join(', ')}: ${
          typeof failed[0]!.error === 'string' ? failed[0]!.error : JSON.stringify(failed[0]!.error)
        }`,
      };
    }
    const total = synced.reduce((sum, s) => sum + s.rows, 0);
    return {
      ok: true,
      synced,
      message: `extracted ${total} record(s) across ${synced.length} stream(s): ${synced.map((s) => `${s.stream} (${s.rows})`).join(', ')}`,
    };
  }
}
