#!/usr/bin/env bun
/**
 * Company Brain CLI — the deterministic executor.
 *
 * OMP is the brain's interface; this CLI is what OMP (or a person) calls so that setup,
 * extraction and skill installation are repeatable instead of improvised shell.
 */
import { Logger } from './core/Logger.ts';
import { Workspace } from './core/Workspace.ts';
import { PmBinary } from './core/PmBinary.ts';
import { PmProject } from './core/PmProject.ts';
import { SkillTransport } from './core/SkillTransport.ts';
import { OmpAgent } from './core/OmpAgent.ts';
import { Doctor } from './core/Doctor.ts';
import { SandboxRunner } from './core/SandboxRunner.ts';

const USAGE = `company-brain

  bun run brain doctor              check prerequisites
  bun run brain build-pm            build pm from source (needs Go; a few minutes)
  bun run brain setup               init project, install skills, create connections
  bun run brain skills              regenerate + transport skills into brain/skills
  bun run brain sync [connector]    extract into the warehouse
  bun run brain tables              list queryable Parquet tables
  bun run brain ask "<question>"    ask the brain on the host (runs omp)

  bun run brain sandbox build              build the sandbox image
  bun run brain sandbox ask "<q>" [ws]     ask inside a sandbox (one volume per workspace)
  bun run brain sandbox stop [ws]          remove the container (volume is kept)
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const log = new Logger();
  const workspace = new Workspace();
  const pm = new PmBinary(workspace, log);
  const project = new PmProject(pm, workspace, log);
  const skills = new SkillTransport(pm, workspace, log);
  const omp = new OmpAgent(workspace);

  switch (command) {
    case 'doctor': {
      log.step('Prerequisites');
      const failed = new Doctor(workspace, log).run().filter((c) => !c.ok);
      return failed.length === 0 ? 0 : 1;
    }

    case 'build-pm': {
      const config = workspace.loadConfig();
      log.step(`Building pm from ${config.pm.repo}@${config.pm.ref}`);
      pm.build(config.pm.repo, config.pm.ref);
      return 0;
    }

    case 'setup': {
      const config = workspace.loadConfig();
      log.step('Workspace');
      workspace.ensureDirectories();
      log.ok(`layout ready under ${workspace.root}`);

      if (!pm.isInstalled()) {
        log.step(`Building pm from ${config.pm.ref}`);
        pm.build(config.pm.repo, config.pm.ref);
      }

      log.step('pm project');
      project.init();

      log.step('Skills');
      skills.install(config.activeSkills);

      log.step('Connectors');
      for (const spec of config.connectors) project.connect(spec);

      log.step('Search skill');
      skills.writeSearchSkill(project.listTables());

      log.ok('setup complete — next: bun run brain sync');
      return 0;
    }

    case 'skills': {
      const config = workspace.loadConfig();
      log.step('Skills');
      skills.install(config.activeSkills);
      skills.writeSearchSkill(project.listTables());
      return 0;
    }

    case 'sync': {
      const config = workspace.loadConfig();
      const only = rest[0];
      const specs = only ? config.connectors.filter((c) => c.connector === only) : config.connectors;
      if (specs.length === 0) { log.fail(`no connector "${only}" in brain.config.json`); return 1; }

      let failures = 0;
      for (const spec of specs) {
        log.step(`Sync ${spec.connector}`);
        for (const result of project.sync(spec)) {
          if (result.status === 'completed' || result.benignFailure) {
            const note = result.benignFailure ? ' (stopped at page budget — rows committed)' : '';
            log.ok(`${result.stream}: ${result.recordsLoaded} records${note}`);
          } else {
            log.fail(`${result.stream}: ${result.error ?? result.status}`);
            failures += 1;
          }
        }
      }

      log.step('Refreshing search skill');
      skills.writeSearchSkill(project.listTables());
      return failures === 0 ? 0 : 1;
    }

    case 'tables': {
      const tables = project.listTables();
      if (tables.length === 0) { log.warn('no tables yet — run `bun run brain sync`'); return 0; }
      for (const t of tables) log.ok(t);
      return 0;
    }

    case 'sandbox': {
      const sandbox = new SandboxRunner(workspace, log);
      const [sub, ...subRest] = rest;
      const wsName = (name: string | undefined) => name ?? 'default';

      if (sub === 'build') { log.step('Sandbox image'); sandbox.buildImage(); return 0; }

      if (sub === 'stop') { sandbox.stop(wsName(subRest[0])); return 0; }

      if (sub === 'ask') {
        const question = subRest[0];
        if (!question) { log.fail('usage: bun run brain sandbox ask "<question>" [workspace]'); return 1; }
        const ws = wsName(subRest[1]);
        log.step(`Sandbox ask (workspace "${ws}")`);
        const result = await sandbox.ask(question, { workspace: ws }, {
          onTool: (name) => log.info(`tool: ${name}`),
          onText: (delta) => process.stdout.write(delta),
        });
        if (!result.text.endsWith('\n')) process.stdout.write('\n');
        return 0;
      }

      log.fail('usage: bun run brain sandbox <build|ask|stop>');
      return 1;
    }

    case 'ask': {
      const question = rest.join(' ').trim();
      if (!question) { log.fail('usage: bun run brain ask "<question>"'); return 1; }
      omp.ask(question);
      return 0;
    }

    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
