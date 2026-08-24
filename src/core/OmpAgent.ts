import { spawnSync } from 'node:child_process';
import type { Workspace } from './Workspace.ts';
import { PrerequisiteError } from './errors.ts';

/**
 * Runs OMP as the reasoning layer.
 *
 * OMP already provides the agent loop, tool use, sessions and skill discovery, so the brain
 * does not implement one. Two details matter: it must run from the workspace root (that is
 * where `.omp/skills` resolves), and stdin must be closed or it blocks in `readPipedInput`.
 */
export class OmpAgent {
  constructor(private readonly workspace: Workspace) {}

  isAvailable(): boolean {
    return spawnSync('which', ['omp'], { encoding: 'utf8' }).status === 0;
  }

  version(): string {
    return spawnSync('omp', ['--version'], { encoding: 'utf8' }).stdout.trim();
  }

  /**
   * Asks a question, streaming OMP's output straight to the terminal.
   * Answers can take minutes; buffering them would look like a hang.
   */
  ask(question: string): void {
    this.assertAvailable();
    const result = spawnSync('omp', ['-p', question], {
      cwd: this.workspace.root,
      // 'ignore' closes stdin — OMP blocks in readPipedInput otherwise.
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (result.status !== 0) throw new Error(`omp exited ${result.status}`);
  }

  /** Asks a question and captures the answer (for programmatic callers). */
  askCapture(question: string): string {
    this.assertAvailable();
    const result = spawnSync('omp', ['-p', question], {
      cwd: this.workspace.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`omp exited ${result.status}`);
    return result.stdout.replace(/^Working\.\.\.\s*/m, '').trim();
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) throw new PrerequisiteError('omp', 'install from https://omp.sh');
  }
}
