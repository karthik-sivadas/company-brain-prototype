import type { Workspace } from './Workspace.ts';
import type { Logger } from './Logger.ts';
import { SandboxRunner } from './SandboxRunner.ts';

/**
 * Measures whether the agent picks the right skill for a question.
 *
 * omp puts every skill's *description* in the system prompt and lets the agent pull the
 * body on demand with `read skill://<name>`. Descriptions are therefore the whole routing
 * surface, and nothing validates them — a description that overlaps another's silently
 * sends questions to the wrong skill. That is exactly how a question about GitHub issues
 * ended up in the 698 KB pm-github connector guide instead of brain-search, and produced
 * "this workspace has no repository" while the data sat in /warehouse.
 *
 * The session transcript is the only record of what was consulted, so each probe runs in
 * its own session directory and the transcript is read back out of the container.
 */

export interface SkillProbe {
  question: string;
  /** Skills that must be consulted. */
  expect?: string[];
  /** Skills that must NOT be consulted. */
  reject?: string[];
  /** Substrings the answer must contain (case-insensitive) — catches right-skill-wrong-answer. */
  answerContains?: string[];
}

export interface ProbeResult {
  question: string;
  consulted: string[];
  answer: string;
  missing: string[];
  forbidden: string[];
  missingText: string[];
  passed: boolean;
  elapsedMs: number;
}

const SKILL_URI = /skill:\/\/([a-z0-9][a-z0-9-]*)/g;

export class SkillProbeRunner {
  private readonly runner: SandboxRunner;

  constructor(private readonly workspace: Workspace, private readonly log: Logger) {
    this.runner = new SandboxRunner(workspace, log);
  }

  /** Skill names read from a session transcript, deduplicated and ordered. */
  static consultedFrom(transcript: string): string[] {
    const seen = new Set<string>();
    for (const match of transcript.matchAll(SKILL_URI)) seen.add(match[1]!);
    return [...seen].sort();
  }

  async run(probes: SkillProbe[], workspaceName = 'skill-probe'): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    const container = `brain-${workspaceName}`;

    for (const [index, probe] of probes.entries()) {
      // A fresh session per probe: a continued session would let an earlier probe's
      // conclusions decide this one, which is the opposite of what we are measuring.
      const sessionDir = `/workspace/sessions/probe-${index}`;
      const startedAt = Date.now();
      this.log.info(`probe ${index + 1}/${probes.length}: ${probe.question}`);

      let answer = '';
      try {
        const turn = await this.runner.ask(probe.question, {
          workspace: workspaceName,
          sandboxName: container,
          volumeName: `brain-ws-${workspaceName}`,
          sessionDir,
          continueSession: false,
        });
        answer = turn.text ?? '';
      } catch (error) {
        answer = `ERROR: ${(error as Error).message}`;
      }

      const transcript = this.runner
        .listFiles(container, sessionDir)
        .map((file) => this.runner.readFile(container, file))
        .join('\n');
      const consulted = SkillProbeRunner.consultedFrom(transcript);

      const missing = (probe.expect ?? []).filter((s) => !consulted.includes(s));
      const forbidden = (probe.reject ?? []).filter((s) => consulted.includes(s));
      const haystack = answer.toLowerCase();
      const missingText = (probe.answerContains ?? []).filter((t) => !haystack.includes(t.toLowerCase()));

      results.push({
        question: probe.question,
        consulted,
        answer,
        missing,
        forbidden,
        missingText,
        passed: missing.length === 0 && forbidden.length === 0 && missingText.length === 0,
        elapsedMs: Date.now() - startedAt,
      });
    }

    this.runner.stop(workspaceName);
    return results;
  }
}
