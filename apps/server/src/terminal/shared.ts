/**
 * Process-wide handle to the shared terminal runner, so HTTP routes (human
 * terminal input) can reach the same runner the agent host uses. Set once at
 * boot from index.ts.
 */
import type { TerminalRunnerHandle } from './runner.js';

let runner: TerminalRunnerHandle | null = null;

export function setSharedTerminalRunner(r: TerminalRunnerHandle | null): void {
  runner = r;
}

export function getSharedTerminalRunner(): TerminalRunnerHandle | null {
  return runner;
}
