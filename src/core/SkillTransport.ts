import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PmBinary } from './PmBinary.ts';
import type { Workspace } from './Workspace.ts';
import type { Logger } from './Logger.ts';

export interface TransportReport {
  generated: number;
  active: string[];
  parked: number;
}

/**
 * Moves skills into the folder the agent reads.
 *
 * `pm skills generate` emits one SKILL.md per connector — 560+ of them. Their descriptions
 * are what an agent loads at startup, so shipping all of them would drown the context.
 * This class generates them, keeps the allow-listed set active, and parks the rest in a
 * catalog directory that stays on disk but outside the agent's discovery path.
 */
export class SkillTransport {
  constructor(
    private readonly pm: PmBinary,
    private readonly workspace: Workspace,
    private readonly log: Logger,
  ) {}

  install(activeSkills: string[]): TransportReport {
    const generated = this.generate();
    const parked = this.park(activeSkills);
    this.workspace.linkSkillsForOmp();

    const active = this.listSkillDirs(this.workspace.skillsDir);
    this.log.ok(`${active.length} active skills, ${parked} parked in .skills-catalog`);
    return { generated, active, parked };
  }

  private generate(): number {
    const result = this.pm.exec<{ skills?: string[] }>(['skills', 'generate', '--dir', this.workspace.skillsDir]);
    const count = result.skills?.length ?? 0;
    this.log.info(`pm generated ${count} connector skills`);
    return count;
  }

  /** Moves every generated skill that is not allow-listed out of the discovery path. */
  private park(activeSkills: string[]): number {
    mkdirSync(this.workspace.skillsCatalogDir, { recursive: true });
    const keep = new Set(activeSkills);
    let parked = 0;

    for (const name of this.listSkillDirs(this.workspace.skillsDir)) {
      if (keep.has(name)) continue;
      if (!name.startsWith('pm-') && !name.startsWith('recipe-')) continue; // never touch hand-written skills
      const target = join(this.workspace.skillsCatalogDir, name);
      rmSync(target, { recursive: true, force: true });
      renameSync(join(this.workspace.skillsDir, name), target);
      parked += 1;
    }
    return parked;
  }

  /** Writes a skill that teaches the agent where the warehouse is and how to query it. */
  writeSearchSkill(tables: string[]): void {
    const dir = join(this.workspace.skillsDir, 'brain-search');
    mkdirSync(dir, { recursive: true });
    const tableList = tables.length
      ? tables.map((t) => `- \`${t}\``).join('\n')
      : '- _(none yet — run `bun run brain sync`)_';

    writeFileSync(join(dir, 'SKILL.md'), `---
name: brain-search
description: How to search the Company Brain. Use for ANY question about company data, synced records, documents or SOPs. Explains where the data lives and how to query it with DuckDB.
---

# brain-search

Data is extracted by \`pm\` into a local warehouse of **Parquet** tables.

## Where things live
- Warehouse tables (query these):
${tableList}
- Find any table: \`find data/pm/.polymetrics/warehouse -name '*.parquet' -not -name 'transport-*'\`
- Documents and SOPs: \`brain/docs/**/*.md\`
- Answers captured from people: \`brain/memory/facts/*.md\`

## How to query
\`\`\`bash
duckdb -c "DESCRIBE SELECT * FROM read_parquet('<path>');"          # discover columns first
duckdb -c "SELECT * FROM read_parquet('<path>') LIMIT 5;"
\`\`\`

## Rules
1. **Look at the real data before answering.** Never guess a column name — \`DESCRIBE\` first.
2. **Cite the source**: the table path or the document path, plus \`html_url\` where rows have one.
3. Search \`brain/docs/\` and \`brain/memory/\` with grep for prose questions.
4. **If the answer is not in the data, say so** and suggest asking a person. Do not invent it.
`);
    this.log.ok(`brain-search skill points at ${tables.length} table(s)`);
  }

  private listSkillDirs(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }
}
