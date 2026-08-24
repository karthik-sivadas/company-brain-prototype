import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { PmBinary } from './PmBinary.ts';
import type { Workspace, ConnectorSpec, StreamSpec } from './Workspace.ts';
import type { Logger } from './Logger.ts';

export interface SyncResult {
  connection: string;
  stream: string;
  status: string;
  recordsRead: number;
  recordsLoaded: number;
  /** pm reports a partial page budget as a failure; the rows are still committed. */
  benignFailure: boolean;
  error?: string;
}

/**
 * Drives one pm project: init, credentials, connections and syncs.
 * Declarative — everything it creates comes from ConnectorSpec entries in brain.config.json.
 */
export class PmProject {
  constructor(
    private readonly pm: PmBinary,
    private readonly workspace: Workspace,
    private readonly log: Logger,
  ) {}

  get isInitialised(): boolean { return existsSync(this.workspace.polymetricsDir); }

  init(): void {
    if (this.isInitialised) { this.log.info('pm project already initialised'); return; }
    this.pm.exec(['init']);
    this.log.ok(`pm project created at ${this.workspace.polymetricsDir}`);
  }

  /** Creates (or replaces) the credential and one connection per declared stream. */
  connect(spec: ConnectorSpec): void {
    this.pm.execTolerant(['credentials', 'remove', spec.credential]);

    const args = ['credentials', 'add', spec.credential, '--connector', spec.connector];
    for (const [key, value] of Object.entries(spec.config)) args.push('--config', `${key}=${value}`);
    for (const [field, envVar] of Object.entries(spec.fromEnv ?? {})) {
      if (!process.env[envVar]) {
        this.log.warn(`${spec.connector}: ${envVar} is not set — skipping (secret stays out of config)`);
        return;
      }
      args.push('--from-env', `${field}=${envVar}`);
    }
    this.pm.exec(args);
    this.log.ok(`credential "${spec.credential}" → ${spec.connector}`);

    this.ensureWarehouseCredential();
    for (const stream of spec.streams) this.createConnection(spec, stream);
  }

  private ensureWarehouseCredential(): void {
    const existing = this.pm.execTolerant<{ credentials?: Array<{ name: string }> }>(['credentials', 'list']);
    if (existing.envelope?.credentials?.some((c) => c.name === 'warehouse')) return;
    this.pm.exec(['credentials', 'add', 'warehouse', '--connector', 'warehouse',
      '--config', 'path=.polymetrics/warehouse']);
    this.log.ok('credential "warehouse" → warehouse');
  }

  private createConnection(spec: ConnectorSpec, stream: StreamSpec): void {
    const name = this.connectionName(spec, stream);
    const result = this.pm.execTolerant([
      'connections', 'create', name,
      '--source', `${spec.connector}:${spec.credential}`,
      '--destination', 'warehouse:warehouse',
      '--stream', stream.name,
      '--primary-key', stream.primaryKey,
      '--cursor', stream.cursor,
      '--table', stream.table,
      '--sync-mode', stream.syncMode ?? 'incremental_append_deduped',
    ]);
    this.log.ok(result.ok ? `connection "${name}"` : `connection "${name}" already present`);
  }

  connectionName(spec: ConnectorSpec, stream: StreamSpec): string {
    return `${spec.connector}_${stream.name}`;
  }

  /** Runs every stream of a connector and normalises pm's result envelope. */
  sync(spec: ConnectorSpec): SyncResult[] {
    return spec.streams.map((stream) => {
      const name = this.connectionName(spec, stream);
      const outcome = this.pm.execTolerant<{ run?: Record<string, unknown>; error?: { message?: string } }>(
        ['etl', 'run', '--connection', name, '--stream', stream.name],
      );
      const run = (outcome.envelope?.run ?? outcome.envelope ?? {}) as Record<string, unknown>;
      const error = String(run.error ?? outcome.envelope?.error?.message ?? '');
      // "page budget before exhaustion" means max_pages stopped it — the rows are committed.
      const benign = /page budget/i.test(error) && Number(run.records_loaded ?? 0) > 0;

      return {
        connection: name,
        stream: stream.name,
        status: String(run.status ?? (outcome.ok ? 'completed' : 'failed')),
        recordsRead: Number(run.records_read ?? 0),
        recordsLoaded: Number(run.records_loaded ?? 0),
        benignFailure: benign,
        error: error || undefined,
      };
    });
  }

  /**
   * Parquet tables the agent can query, as paths RELATIVE to the warehouse root.
   *
   * Relative, because the same list is baked into a skill that is read both on the
   * host and inside the sandbox, where the warehouse is mounted at a different
   * prefix. An absolute host path is a dead link in the container.
   */
  listTables(): string[] {
    const root = this.workspace.warehouseDir;
    const found: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.parquet') && !entry.name.startsWith('transport-')
                 && basename(dir) === 'tables') {
          found.push(relative(root, full));
        }
      }
    };
    walk(root);
    return found.sort();
  }
}
