import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from './Workspace.ts';
import type { Logger } from './Logger.ts';
import { OmpRpcClient, type TurnEvents, type TurnResult } from './OmpRpcClient.ts';
import { PrerequisiteError } from './errors.ts';

export interface SandboxOptions {
  /** Logical workspace name. Each gets exactly one persistent volume. */
  workspace: string;
  /** Explicit container/volume names, used by the Slack bridge for per-thread sandboxes. */
  sandboxName?: string;
  volumeName?: string;
  image?: string;
  memory?: string;
  pids?: number;
  /** Mount the host's omp credentials so the agent can reach a model. Auth hardening is future work. */
  shareCredentials?: boolean;
}

/**
 * Runs the agent inside a container instead of on the host.
 *
 * Layout, and the reason for each choice:
 *   /workspace   the ONE volume per workspace — sessions and scratch; the only writable mount
 *   /brain       skills and documents, read-only (the agent must not rewrite its own instructions)
 *   /warehouse   pm's Parquet output, read-only — but see /pmroot: the warehouse lives
 *                INSIDE the pm project, so this :ro mount is not a real guarantee
 *   /pmroot      the pm project, writable — pm runs here so the agent can extract data itself
 *
 * The container is hardened: non-root, read-only root filesystem, all capabilities dropped,
 * no privilege escalation, memory and PID caps, and no Docker socket.
 */
export class SandboxRunner {
  private static readonly IMAGE = 'company-brain-sandbox:local';

  constructor(private readonly workspace: Workspace, private readonly log: Logger) {}

  private get docker(): string { return 'docker'; }

  assertDocker(): void {
    const info = spawnSync(this.docker, ['info'], { encoding: 'utf8' });
    if (info.status !== 0) {
      throw new PrerequisiteError('docker', 'start Docker (e.g. `colima start`)');
    }
  }

  imageExists(image = SandboxRunner.IMAGE): boolean {
    return spawnSync(this.docker, ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
  }

  buildImage(image = SandboxRunner.IMAGE): void {
    this.assertDocker();
    this.log.info('building sandbox image (first run pulls duckdb and omp)');
    const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
    const result = spawnSync(this.docker, [
      'build', '-f', join(this.workspace.root, 'docker', 'sandbox.Dockerfile'),
      '-t', image, '--build-arg', `TARGETARCH=${arch}`,
      join(this.workspace.root, 'docker'),
    ], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('sandbox image build failed');
    this.log.ok(`image ${image} ready`);
  }

  /** One volume per workspace, created on demand. */
  volumeName(workspace: string): string { return `brain-ws-${workspace}`; }

  ensureVolume(workspace: string, explicit?: string): string {
    const name = explicit ?? this.volumeName(workspace);
    if (spawnSync(this.docker, ['volume', 'inspect', name], { stdio: 'ignore' }).status !== 0) {
      spawnSync(this.docker, ['volume', 'create', name], { stdio: 'ignore' });
      this.log.ok(`created volume ${name}`);
    }
    return name;
  }

  containerName(workspace: string): string { return `brain-${workspace}`; }

  isRunning(workspace: string): boolean {
    return this.isContainerRunning(this.containerName(workspace));
  }

  isContainerRunning(name: string): boolean {
    const out = spawnSync(this.docker, ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' });
    return out.status === 0 && out.stdout.trim() === 'true';
  }

  /** Removes a container by explicit name, keeping its volume. Used by the idle reaper. */
  stopContainer(name: string): void {
    spawnSync(this.docker, ['rm', '-f', name], { stdio: 'ignore' });
  }

  /** Starts (or reuses) the workspace container. Idempotent. */
  start(options: SandboxOptions): string {
    this.assertDocker();
    const image = options.image ?? SandboxRunner.IMAGE;
    if (!this.imageExists(image)) this.buildImage(image);

    const name = options.sandboxName ?? this.containerName(options.workspace);
    if (this.isContainerRunning(name)) return name;
    spawnSync(this.docker, ['rm', '-f', name], { stdio: 'ignore' }); // clear a stopped leftover

    const volume = this.ensureVolume(options.workspace, options.volumeName);
    const args = [
      'run', '-d', '--name', name,
      '--user', '10001:10001',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges',
      '--memory', options.memory ?? '2g',
      '--pids-limit', String(options.pids ?? 512),
      '-v', `${volume}:/workspace`,
      '-v', `${this.workspace.brainDir}:/brain:ro`,
      // Read-only, and honest about what that buys: the warehouse sits inside the pm
      // project mounted rw below, so this is the *convenient* read path, not a boundary.
      // Making it one means moving the warehouse out from under data/pm.
      '-v', `${this.workspace.warehouseDir}:/warehouse:ro`,
      // The pm project, writable: pm is baked into the image, so the agent can inspect
      // connectors and run extraction itself instead of asking the host to do it.
      // pm is rooted by working directory, so it is used as `cd /pmroot && pm …`.
      '-v', `${this.workspace.pmProjectDir}:/pmroot`,
    ];

    if (options.shareCredentials !== false) {
      // Model credentials live in ~/.omp/agent/agent.db. Mounted rw because SQLite needs its
      // WAL, and nested inside the workspace volume so HOME stays writable under a read-only
      // rootfs. Replacing this with a scoped token is the authorization work we deferred.
      // Mounted OUTSIDE the workspace volume and copied in by the entrypoint: a bind nested
      // inside a volume makes Docker create root-owned parents, which a non-root agent cannot
      // write to. Copying also keeps the host's credential DB untouched.
      args.push('-v', `${join(homedir(), '.omp', 'agent')}:/opt/omp-credentials:ro`);
    }

    args.push(image, 'sleep', 'infinity');

    const result = spawnSync(this.docker, args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`docker run failed: ${result.stderr.trim()}`);
    this.log.ok(`sandbox ${name} running (volume ${volume})`);
    return name;
  }

  /**
   * Reads a file out of a running sandbox. Used by the skill probe to inspect the
   * session transcript, which is the only record of which skills the agent consulted.
   */
  readFile(container: string, path: string): string {
    const out = spawnSync(this.docker, ['exec', container, 'cat', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.status === 0 ? out.stdout : '';
  }

  /** Runs a command inside a running sandbox. */
  exec(container: string, argv: string[]): void {
    spawnSync(this.docker, ['exec', container, ...argv], { stdio: 'ignore' });
  }

  /** Lists files under a directory inside a running sandbox. */
  listFiles(container: string, dir: string): string[] {
    const out = spawnSync(this.docker, ['exec', container, 'find', dir, '-type', 'f', '-name', '*.jsonl'], { encoding: 'utf8' });
    return out.status === 0 ? out.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }

  stop(workspace: string): void {
    spawnSync(this.docker, ['rm', '-f', this.containerName(workspace)], { stdio: 'ignore' });
    this.log.ok(`sandbox ${this.containerName(workspace)} removed (volume kept)`);
  }

  /**
   * Opens an RPC session inside the sandbox and runs one prompt.
   *
   * `sessionDir` + `continueSession` is what makes a Slack thread remember itself: a fresh
   * process pointed at the same directory with `--continue` resumes the conversation, verified
   * across three separate processes.
   */
  async ask(
    question: string,
    options: SandboxOptions & { sessionDir?: string; continueSession?: boolean },
    events: TurnEvents = {},
  ): Promise<TurnResult> {
    const name = this.start(options);
    const sessionDir = options.sessionDir ?? '/workspace/sessions';
    // omp's default system prompt is a coding-assistant prompt, which sent the agent
    // looking for .git/config and package.json and pulled it into omp's live `issue://`
    // GitHub resource. The container is NOT sealed — no --network flag is passed, so egress
    // is open — but there is no repository in it and no gh CLI. The brief states the real
    // environment and points at the warehouse as the source of truth.
    const args = [
      'exec', '-i', '-w', '/workspace', name,
      'omp', '--mode', 'rpc',
      '--session-dir', sessionDir,
      '--append-system-prompt', '/brain/AGENT-BRIEF.md',
    ];
    if (options.continueSession) args.push('--continue');
    const child = spawn(this.docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const client = new OmpRpcClient(child.stdin, child.stdout);

    // Without this, a child that dies early — the container reaped underneath it, docker
    // failing, omp exiting on a bad model config — leaves every RPC waiter pending until the
    // turn timeout while holding a concurrency slot. The exit code and captured stderr are
    // the only diagnosis available, so they go into the error.
    const died = new Promise<never>((_resolve, reject) => {
      child.once('error', (err) => reject(new Error(`docker exec failed: ${err.message}`)));
      child.once('exit', (code, signal) => reject(new Error(
        `the sandbox process exited early (${signal ? `signal ${signal}` : `code ${code}`})`,
      )));
    });

    try {
      await Promise.race([client.waitForReady(), died]);
      return await Promise.race([client.prompt(question, events), died]);
    } catch (error) {
      const detail = stderr.trim().slice(0, 400);
      throw new Error(`${(error as Error).message}${detail ? `\n  sandbox stderr: ${detail}` : ''}`);
    } finally {
      child.kill();
    }
  }
}
