import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from './Workspace.ts';
import type { Logger } from './Logger.ts';
import { PmCommandError, PrerequisiteError } from './errors.ts';

/**
 * Owns the `pm` binary: building it from source and running it safely.
 *
 * Two invariants live here so no caller can get them wrong:
 *  1. `pm` auto-creates `.polymetrics/` in the process CWD, so every invocation is pinned
 *     to the project directory.
 *  2. `--json` is always appended, so callers get versioned envelopes rather than prose.
 */
export class PmBinary {
  constructor(
    private readonly workspace: Workspace,
    private readonly log: Logger,
  ) {}

  get path(): string { return this.workspace.pmBinary; }
  isInstalled(): boolean { return existsSync(this.path); }

  /** Clones (or refreshes) polymetrics-ai/cli and compiles it. CGO is required by the DuckDB driver. */
  build(repo: string, ref: string): void {
    if (!this.hasTool('go')) throw new PrerequisiteError('go', 'install Go (https://go.dev/dl/)');
    if (!this.hasTool('git')) throw new PrerequisiteError('git', 'install git');

    mkdirSync(this.workspace.buildDir, { recursive: true });
    const src = join(this.workspace.buildDir, 'cli');

    if (existsSync(join(src, '.git'))) {
      this.log.info('refreshing existing checkout');
      this.run('git', ['fetch', '--depth', '1', 'origin', ref], src);
      this.run('git', ['reset', '--hard', `origin/${ref}`], src);
    } else {
      this.log.info(`cloning ${repo}`);
      this.run('git', ['clone', '--depth', '1', '--branch', ref, repo, src], this.workspace.buildDir);
    }

    const head = spawnSync('git', ['log', '-1', '--format=%h %s'], { cwd: src, encoding: 'utf8' });
    this.log.info(`HEAD ${head.stdout.trim()}`);

    this.log.info('compiling (CGO on — the DuckDB driver needs it; takes a few minutes)');
    // CGO_ENABLED=0 fails with "undefined: Conn" inside go-duckdb.
    this.run('go', ['build', '-o', 'pm', './cmd/pm'], src, { CGO_ENABLED: '1' });

    mkdirSync(this.workspace.binDir, { recursive: true });
    copyFileSync(join(src, 'pm'), this.path);
    chmodSync(this.path, 0o755);
    this.log.ok(`pm installed at ${this.path}`);
  }

  /** Runs a pm subcommand in the project directory and returns the parsed JSON envelope. */
  exec<T = unknown>(args: string[]): T {
    if (!this.isInstalled()) {
      throw new PrerequisiteError('pm', 'run `bun run brain build-pm`');
    }
    const argv = [...args, '--json'];
    const result = spawnSync(this.path, argv, {
      cwd: this.workspace.pmProjectDir, // pm writes .polymetrics/ here — never anywhere else
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    let envelope: unknown;
    try { envelope = JSON.parse(result.stdout); } catch { /* not every failure prints JSON */ }

    if (result.status !== 0) {
      throw new PmCommandError(argv, result.status ?? -1, result.stderr || result.stdout, envelope);
    }
    return envelope as T;
  }

  /** Like exec, but returns the envelope even on a non-zero exit (pm reports partial runs this way). */
  execTolerant<T = unknown>(args: string[]): { ok: boolean; envelope?: T; stderr: string } {
    try {
      return { ok: true, envelope: this.exec<T>(args), stderr: '' };
    } catch (error) {
      if (error instanceof PmCommandError) {
        return { ok: false, envelope: error.envelope as T | undefined, stderr: error.stderr };
      }
      throw error;
    }
  }

  private hasTool(tool: string): boolean {
    return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0;
  }

  private run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): void {
    const result = spawnSync(cmd, args, {
      cwd, stdio: 'inherit', env: { ...process.env, ...env },
    });
    if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`);
  }
}
