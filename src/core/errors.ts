/** Raised when a required external tool is missing or unusable. */
export class PrerequisiteError extends Error {
  constructor(tool: string, remedy: string) {
    super(`${tool} is unavailable — ${remedy}`);
    this.name = 'PrerequisiteError';
  }
}

/** Raised when a `pm` invocation fails. Carries the parsed envelope when there is one. */
export class PmCommandError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
    readonly envelope?: unknown,
  ) {
    super(`pm ${argv.join(' ')} failed (exit ${exitCode}): ${stderr.trim().slice(0, 300)}`);
    this.name = 'PmCommandError';
  }
}
