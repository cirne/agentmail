/**
 * Timer utilities for measuring operation durations.
 */

export interface TimerOptions {
  /** Optional logger for slow operation warnings */
  logger?: {
    debug: (msg: string, data?: Record<string, unknown>) => void;
    info?: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
  };
  /** Threshold in milliseconds to log slow operations */
  logSlow?: number;
  /** Log level for slow operations (default: 'debug') */
  logLevel?: 'debug' | 'info' | 'warn';
}

/**
 * Time an async operation and return the result with duration.
 * 
 * @example
 * ```typescript
 * const { result, durationMs } = await withTimer("operation", () => doSomething());
 * ```
 * 
 * @example With slow operation logging
 * ```typescript
 * const { result, durationMs } = await withTimer(
 *   "parse",
 *   () => parseMessage(raw),
 *   { logSlow: 500, logLevel: 'debug', logger: fileLogger }
 * );
 * ```
 */
export async function withTimer<T>(
  label: string,
  fn: () => Promise<T>,
  options?: TimerOptions
): Promise<{ result: T; durationMs: number }> {
  const startMs = Date.now();
  
  const result = await fn();
  
  const endMs = Date.now();
  const durationMs = endMs - startMs;
  
  if (options?.logSlow && durationMs > options.logSlow && options.logger) {
    const level = options.logLevel || 'debug';
    const logFn = options.logger[level] || options.logger.debug;
    logFn(`Slow ${label}`, { durationMs, threshold: options.logSlow });
  }
  
  return { result, durationMs };
}
