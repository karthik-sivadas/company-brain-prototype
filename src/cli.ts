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

  bun run brain slack doctor               check Slack tokens and prerequisites
  bun run brain slack start                run the Slack bridge (Socket Mode)
  bun run brain slack threads              list known Slack threads and their sandboxes
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

    case 'slack': {
      const { SlackBridge } = await import('./slack/SlackBridge.ts');
      const { ThreadRouter } = await import('./slack/ThreadRouter.ts');
      const [sub] = rest;
      const botToken = process.env.SLACK_BOT_TOKEN ?? '';
      const appToken = process.env.SLACK_APP_TOKEN ?? '';

      if (sub === 'doctor') {
        const offline = rest.includes('--offline');
        log.step('Slack prerequisites');

        // Shape checks first — they need no network and catch swapped tokens.
        let healthy = true;
        const shape: Array<[string, boolean, string]> = [
          ['SLACK_BOT_TOKEN', botToken.startsWith('xoxb-'), botToken ? 'looks like a bot token' : 'missing (xoxb-…)'],
          ['SLACK_APP_TOKEN', appToken.startsWith('xapp-'), appToken ? 'looks like an app-level token' : 'missing (xapp-…, needs connections:write)'],
        ];
        for (const [name, ok, detail] of shape) {
          if (ok) log.ok(`${name} — ${detail}`);
          else { log.fail(`${name} — ${detail}`); healthy = false; }
        }

        if (!offline && botToken) {
          const { checkBotToken, checkMembership, checkAppToken, REQUIRED_BOT_SCOPES, OPTIONAL_BOT_SCOPES } =
            await import('./slack/SlackPreflight.ts');

          log.step('Bot token (live, read-only)');
          const bot = await checkBotToken(botToken);
          if (!bot.ok || !bot.identity) {
            log.fail(`auth.test failed — ${bot.error}`);
            healthy = false;
          } else {
            const id = bot.identity;
            log.ok(`authenticated as @${id.botUser} in ${id.team} (${id.teamId})`);
            log.info(`bot_id ${id.botId} · user_id ${id.userId} · ${id.url}`);

            if (bot.missingRequired.length === 0) {
              log.ok(`all ${Object.keys(REQUIRED_BOT_SCOPES).length} scopes the bridge needs are granted`);
            } else {
              healthy = false;
              for (const scope of bot.missingRequired) log.fail(`missing scope ${scope} — ${REQUIRED_BOT_SCOPES[scope]}`);
              log.info('add the scope, then reinstall the app — editing the manifest alone does not regrant it');
            }
            for (const scope of bot.missingOptional) log.info(`optional scope ${scope} absent — ${OPTIONAL_BOT_SCOPES[scope]}`);

            // A bot in no channel receives no events, which reads as a hang.
            const channels = await checkMembership(botToken, bot.granted);
            if ('error' in channels) {
              log.info(`channel membership unknown — ${channels.error}`);
            } else {
              const joined = channels.filter((c) => c.isMember);
              if (joined.length > 0) {
                for (const c of joined) log.ok(`in #${c.name} (${c.id})${c.isPrivate ? ' · private' : ''}`);
              } else {
                healthy = false;
                log.fail('the bot is in no channel, so it will receive no events');
                const sample = channels[0];
                log.info(`invite it: /invite @${bot.identity.botUser}${sample ? ` in #${sample.name}` : ''}`);
              }
            }
          }

          if (appToken) {
            log.step('App-level token (Socket Mode handshake)');
            const app = await checkAppToken(appToken);
            if (app.ok) log.ok('apps.connections.open succeeded — Socket Mode is enabled and the token is valid');
            else { log.fail(`apps.connections.open failed — ${app.error}${app.hint ? ` (${app.hint})` : ''}`); healthy = false; }
          } else {
            log.warn('no app-level token, so the websocket cannot be opened — `slack start` will not run');
            log.info('Basic Information → App-Level Tokens → Generate, with scope connections:write');
          }
        } else if (offline) {
          log.info('--offline: skipped the live Slack calls');
        }

        log.step('Local runtime');
        const sandbox = new SandboxRunner(workspace, log);
        try { sandbox.assertDocker(); log.ok('docker reachable'); }
        catch (e) { log.fail((e as Error).message); healthy = false; }
        log.info(sandbox.imageExists() ? 'sandbox image present' : 'sandbox image missing → bun run brain sandbox build');
        const router = new ThreadRouter(workspace);
        log.info(`known threads: ${router.all().length}`);
        return healthy ? 0 : 1;
      }

      if (sub === 'threads') {
        const router = new ThreadRouter(workspace);
        const all = router.all();
        if (all.length === 0) { log.info('no threads yet'); return 0; }
        for (const t of all) log.ok(`${t.threadKey} · turns=${t.turns} · ${t.sandbox} · last ${t.lastTurnAt}`);
        return 0;
      }

      if (sub === 'start') {
        // @slack/socket-mode opens its websocket with undici's WebSocket and detects
        // pongs through the `undici:websocket:pong` diagnostics channel. Bun resolves
        // `undici` to a built-in shim with no WebSocket at all, and its native
        // WebSocket never publishes to that channel — so under Bun the bridge either
        // fails to construct or silently reconnect-loops once the heartbeat starts.
        // Bolt v5 supports Node >= 20; run the bridge there.
        if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
          log.fail('the Slack bridge cannot run under Bun — @slack/socket-mode needs real undici');
          log.info('run it on Node instead:  npm run slack:start');
          return 1;
        }
        if (!botToken || !appToken) {
          log.fail('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required — see `brain slack doctor`');
          return 1;
        }
        log.step('Slack bridge');
        const channels = (process.env.SLACK_CHANNELS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
        const bridge = new SlackBridge(workspace, log, {
          botToken, appToken, channels,
          maxConcurrent: Number(process.env.BRAIN_MAX_CONCURRENT ?? 4),
          idleReapMinutes: Number(process.env.BRAIN_IDLE_REAP_MINUTES ?? 15),
        });
        await bridge.start();
        const shutdown = async () => { await bridge.stop(); process.exit(0); };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await new Promise(() => {}); // run until signalled
        return 0;
      }

      log.fail('usage: bun run brain slack <doctor|start|threads>');
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
