import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import type { MaildirParseJob, MaildirParseResult } from "./rebuild-parse-job.js";

const here = dirname(fileURLToPath(import.meta.url));
const jobEntry = existsSync(join(here, "rebuild-parse-job.ts"))
  ? join(here, "rebuild-parse-job.ts")
  : join(here, "rebuild-parse-job.js");

const { runMaildirParseJob } = await import(pathToFileURL(jobEntry).href);

let chain = Promise.resolve();

parentPort!.on("message", (job: MaildirParseJob) => {
  chain = chain.then(async () => {
    const result: MaildirParseResult = await runMaildirParseJob(job);
    parentPort!.postMessage(result);
  });
});
