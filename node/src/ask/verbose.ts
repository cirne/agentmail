/**
 * Verbose logging for the ask pipeline (phase 1, context assembly, etc.).
 * Off by default; enable with --verbose so normal runs only show the answer.
 */

let enabled = false;

export function setVerbose(value: boolean): void {
  enabled = value;
}

export function verboseLog(message: string): void {
  if (enabled) {
    process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  }
}
