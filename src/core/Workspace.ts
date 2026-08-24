import { mkdirSync, existsSync, symlinkSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ConnectorSpec {
  /** pm connector slug, e.g. "github". */
  connector: string;
  /** Local credential name pm will store. */
  credential: string;
  /** Non-secret config passed as --config k=v. */
  config: Record<string, string>;
  /** Secret fields sourced from env: field -> ENV_VAR (pm reads via --from-env). */
  fromEnv?: Record<string, string>;
  streams: StreamSpec[];
}

export interface StreamSpec {
  name: string;
  primaryKey: string;
  cursor: string;
  table: string;
  syncMode?: string;
}

export interface BrainConfig {
  pm: { repo: string; ref: string };
  /** Skills kept active; everything else generated is parked out of the agent's context. */
  activeSkills: string[];
  connectors: ConnectorSpec[];
}

/**
 * Owns the on-disk layout and is the single source of truth for paths.
 * Every other class asks the Workspace where things live rather than joining paths itself.
 */
export class Workspace {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  }

  get binDir(): string { return join(this.root, 'bin'); }
  get pmBinary(): string { return join(this.binDir, 'pm'); }
  get buildDir(): string { return join(this.root, '.build'); }
  get pmProjectDir(): string { return join(this.root, 'data', 'pm'); }
  get polymetricsDir(): string { return join(this.pmProjectDir, '.polymetrics'); }
  get warehouseDir(): string { return join(this.polymetricsDir, 'warehouse'); }
  get brainDir(): string { return join(this.root, 'brain'); }
  get skillsDir(): string { return join(this.brainDir, 'skills'); }
  get skillsCatalogDir(): string { return join(this.brainDir, '.skills-catalog'); }
  get docsDir(): string { return join(this.brainDir, 'docs'); }
  get memoryDir(): string { return join(this.brainDir, 'memory'); }
  get agentsDir(): string { return join(this.brainDir, 'agents'); }
  get ompSkillsLink(): string { return join(this.root, '.omp', 'skills'); }
  get configPath(): string { return join(this.root, 'brain.config.json'); }

  /** Creates every directory the brain expects. Idempotent. */
  ensureDirectories(): void {
    for (const dir of [
      this.binDir, this.pmProjectDir, this.skillsDir, this.skillsCatalogDir,
      this.docsDir, join(this.memoryDir, 'facts'), join(this.memoryDir, 'questions'),
      this.agentsDir, dirname(this.ompSkillsLink),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Points OMP's skill-discovery path at brain/skills.
   * OMP reads `.omp/skills/`, so a symlink keeps one canonical copy of the skills.
   */
  linkSkillsForOmp(): void {
    const link = this.ompSkillsLink;
    if (existsSync(link) || this.isBrokenLink(link)) rmSync(link, { recursive: true, force: true });
    symlinkSync(this.skillsDir, link, 'dir');
  }

  private isBrokenLink(path: string): boolean {
    try { lstatSync(path); return true; } catch { return false; }
  }

  loadConfig(): BrainConfig {
    if (!existsSync(this.configPath)) {
      throw new Error(`missing ${this.configPath} — run \`bun run brain setup\` first`);
    }
    return JSON.parse(readFileSync(this.configPath, 'utf8')) as BrainConfig;
  }
}
