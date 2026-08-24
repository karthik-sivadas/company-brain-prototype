/** Tiny console reporter. Keeps command output readable without a logging dependency. */
export class Logger {
  constructor(private readonly quiet = false) {}

  step(message: string): void {
    if (!this.quiet) console.log(`\n▸ ${message}`);
  }
  ok(message: string): void {
    if (!this.quiet) console.log(`  ✓ ${message}`);
  }
  info(message: string): void {
    if (!this.quiet) console.log(`  · ${message}`);
  }
  warn(message: string): void {
    console.warn(`  ! ${message}`);
  }
  fail(message: string): void {
    console.error(`  ✗ ${message}`);
  }
}
