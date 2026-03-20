import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getZmailWorkerConcurrency } from "~/lib/worker-concurrency";
import { logger } from "~/lib/logger";
import {
  runMaildirParseJob,
  type MaildirParseJob,
  type MaildirParseResult,
} from "./rebuild-parse-job.js";

/** @see getZmailWorkerConcurrency — shared env `ZMAIL_WORKER_CONCURRENCY` */
export function getRebuildParseConcurrency(): number {
  return getZmailWorkerConcurrency();
}

/**
 * Prefer `dist/db/rebuild-parse-worker.js` so the worker runs as plain Node ESM (one process,
 * worker threads — each thread is its own V8 isolate, not a second Node process). Loading `.ts`
 * workers from `src/` requires tsx and still breaks on `.js` import specifiers next to `.ts` sources.
 */
export function getRebuildParseWorkerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(here, "..", "..");
  const distWorker = join(projectRoot, "dist", "db", "rebuild-parse-worker.js");
  if (existsSync(distWorker)) {
    return distWorker;
  }
  const localJs = join(here, "rebuild-parse-worker.js");
  if (existsSync(localJs)) {
    return localJs;
  }
  const tsPath = join(here, "rebuild-parse-worker.ts");
  if (existsSync(tsPath)) {
    return tsPath;
  }
  return distWorker;
}

/** Node must load the ts entry with tsx so `.js` import specifiers resolve to `.ts` sources. */
function workerExecArgv(scriptPath: string): string[] {
  if (!scriptPath.endsWith(".ts")) {
    return process.execArgv;
  }
  const argv = [...process.execArgv];
  const hasTsxImport = argv.some(
    (a, i) => (a === "--import" || a === "--loader") && String(argv[i + 1] ?? "").includes("tsx")
  );
  if (!hasTsxImport) {
    argv.push("--import", "tsx");
  }
  return argv;
}

function postJob(worker: Worker, job: MaildirParseJob): Promise<MaildirParseResult> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: unknown) => {
      cleanup();
      resolve(msg as MaildirParseResult);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      worker.off("message", onMessage);
      worker.off("error", onError);
    }
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.postMessage(job);
  });
}

/**
 * Parse many maildir jobs using up to `concurrency` worker threads, or the main thread when
 * concurrency ≤ 1. Preserves result order aligned with `jobs`.
 */
export async function parseMaildirJobsWithPool(
  jobs: MaildirParseJob[],
  concurrency: number
): Promise<MaildirParseResult[]> {
  if (jobs.length === 0) {
    return [];
  }

  const n = Math.min(Math.max(1, concurrency), jobs.length);

  if (n <= 1) {
    const out: MaildirParseResult[] = [];
    for (const job of jobs) {
      out.push(await runMaildirParseJob(job));
    }
    return out;
  }

  const script = getRebuildParseWorkerEntry();
  if (script.endsWith(".ts")) {
    if (n > 1) {
      logger.warn(
        "Parallel maildir parse needs compiled workers (`npm run build`); falling back to main-thread parse."
      );
    }
    const out: MaildirParseResult[] = [];
    for (const job of jobs) {
      out.push(await runMaildirParseJob(job));
    }
    return out;
  }

  const workers = Array.from(
    { length: n },
    () => new Worker(script, { execArgv: workerExecArgv(script) })
  );

  const results: MaildirParseResult[] = new Array(jobs.length);
  let next = 0;

  async function drain(worker: Worker) {
    for (;;) {
      const idx = next++;
      if (idx >= jobs.length) {
        break;
      }
      const job = jobs[idx]!;
      results[idx] = await postJob(worker, job);
    }
  }

  try {
    await Promise.all(workers.map((w) => drain(w)));
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }

  return results;
}
