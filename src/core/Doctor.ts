import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Workspace } from './Workspace.ts';
import type { Logger } from './Logger.ts';

export interface Check { name: string; ok: boolean; detail: string; remedy?: string }

/** Preflight: every external dependency the brain needs, with a fix for each failure. */
export class Doctor {
  constructor(private readonly workspace: Workspace, private readonly log: Logger) {}

  run(): Check[] {
    const checks: Check[] = [
      this.tool('omp', 'the agent runtime', 'install from https://omp.sh'),
      this.tool('duckdb', 'queries the warehouse', 'brew install duckdb'),
      this.tool('go', 'builds pm', 'https://go.dev/dl/ (only needed to build pm)'),
      this.tool('git', 'clones pm', 'install git'),
      {
        name: 'pm binary',
        ok: existsSync(this.workspace.pmBinary),
        detail: this.workspace.pmBinary,
        remedy: 'bun run brain build-pm',
      },
      {
        name: 'pm project',
        ok: existsSync(this.workspace.polymetricsDir),
        detail: this.workspace.polymetricsDir,
        remedy: 'bun run brain setup',
      },
      {
        name: 'skills linked for omp',
        ok: existsSync(this.workspace.ompSkillsLink),
        detail: `${this.workspace.ompSkillsLink} → brain/skills`,
        remedy: 'bun run brain setup',
      },
    ];

    for (const c of checks) {
      if (c.ok) this.log.ok(`${c.name} — ${c.detail}`);
      else this.log.fail(`${c.name} — ${c.detail}${c.remedy ? `  → ${c.remedy}` : ''}`);
    }
    return checks;
  }

  private tool(bin: string, purpose: string, remedy: string): Check {
    const found = spawnSync('which', [bin], { encoding: 'utf8' });
    const ok = found.status === 0;
    return { name: bin, ok, detail: ok ? `${found.stdout.trim()} (${purpose})` : `missing (${purpose})`, remedy };
  }
}
