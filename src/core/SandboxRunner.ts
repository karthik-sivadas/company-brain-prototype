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
 *   /warehouse   pm's Parquet output, read-only (the agent queries data, it cannot corrupt it)
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

  ensureVolume(workspace: string): string {
    const name = this.volumeName(workspace);
    if (spawnSync(this.docker, ['volume', 'inspect', name], { stdio: 'ignore' }).status !== 0) {
      spawnSync(this.docker, ['volume', 'create', name], { stdio: 'ignore' });
      this.log.ok(`created volume ${name}`);
    }
    return name;
  }

  containerName(workspace: string): string { return `brain-${workspace}`; }

  isRunning(workspace: string): boolean {
    const out = spawnSync(this.docker,
      ['inspect', '-f', '{{.State.Running}}', this.containerName(workspace)], { encoding: 'utf8' });
    return out.status === 0 && out.stdout.trim() === 'true';
  }

  /** Starts (or reuses) the workspace container. Idempotent. */
  start(options: SandboxOptions): string {
    this.assertDocker();
    const image = options.image ?? SandboxRunner.IMAGE;
    if (!this.imageExists(image)) this.buildImage(image);

    const name = this.containerName(options.workspace);
    if (this.isRunning(options.workspace)) return name;
    spawnSync(this.docker, ['rm', '-f', name], { stdio: 'ignore' }); // clear a stopped leftover

    const volume = this.ensureVolume(options.workspace);
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
      '-v', `${this.workspace.warehouseDir}:/warehouse:ro`,
    ];

    if (options.shareCredentials !== false) {
      // Model credentials live in ~/.omp/agent/agent.db. Mounted rw because SQLite needs its
      // WAL. Replacing this with a scoped token is the authorization work we deferred.
      args.push('-v', `${join(homedir(), '.omp', 'agent')}:/home/agent/.omp/agent`);
    }

    args.push(image, 'sleep', 'infinity');

    const result = spawnSync(this.docker, args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`docker run failed: ${result.stderr.trim()}`);
    this.log.ok(`sandbox ${name} running (volume ${volume})`);
    return name;
  }

  stop(workspace: string): void {
    spawnSync(this.docker, ['rm', '-f', this.containerName(workspace)], { stdio: 'ignore' });
    this.log.ok(`sandbox ${this.containerName(workspace)} removed (volume kept)`);
  }

  /** Opens an RPC session inside the sandbox and runs one prompt. */
  async ask(question: string, options: SandboxOptions, events: TurnEvents = {}): Promise<TurnResult> {
    const name = this.start(options);
    const child = spawn(this.docker, [
      'exec', '-i', '-w', '/workspace', name,
      'omp', '--mode', 'rpc', '--session-dir', '/workspace/sessions',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const client = new OmpRpcClient(child.stdin, child.stdout);
    try {
      await client.waitForReady();
      return await client.prompt(question, events);
    } catch (error) {
      const detail = stderr.trim().slice(0, 400);
      throw new Error(`${(error as Error).message}${detail ? `\n  sandbox stderr: ${detail}` : ''}`);
    } finally {
      child.kill();
    }
  }
}
