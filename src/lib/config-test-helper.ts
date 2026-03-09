/**
 * Test helper: prints config as JSON. Run with ZMAIL_HOME set.
 * Used by config.test.ts via spawn to verify config loading.
 */
import { config } from "./config";

let openaiKeySet = false;
try {
  openaiKeySet = config.openai.apiKey.length > 0;
} catch {
  openaiKeySet = false;
}

const output = {
  imap: {
    host: config.imap.host,
    port: config.imap.port,
    user: config.imap.user,
  },
  sync: {
    defaultSince: config.sync.defaultSince,
    mailbox: config.sync.mailbox,
    excludeLabels: config.sync.excludeLabels,
  },
  openaiKeySet,
};
console.log(JSON.stringify(output));
