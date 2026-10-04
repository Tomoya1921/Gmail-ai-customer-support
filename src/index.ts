
import 'dotenv/config';
import { google } from 'googleapis';
import OpenAI from 'openai';
import { readConfig } from './config';
import { authorize } from './gmail';
import { logEvent } from './logger';
import { processInbox } from './processInbox';
import { createReplyDraftText } from './reply';

async function main(): Promise<void> {
  const config = readConfig(process.env);
  logEvent('started');
  const auth = await authorize();
  const gmail = google.gmail({ version: 'v1', auth, timeout: 60_000, retry: false });
  const client = new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: 60_000 });
  const result = await processInbox({
    gmail, maxEmails: config.maxEmails,
    generateReply: (email) => createReplyDraftText(email, client, config.model),
  });
  if (result.failed > 0) process.exitCode = 1;
}

main().catch(() => {
  // API例外には本文・認証情報が含まれ得るため、そのまま出力しない。
  logEvent('startup_failed');
  process.exitCode = 1;
});
