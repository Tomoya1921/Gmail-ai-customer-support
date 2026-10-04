import type { gmail_v1 } from 'googleapis';
import { MAX_EMAILS_PER_RUN, parseMaxEmails } from './config';
import { createGmailDraft, findOrCreateLabelId, getEmailDetails,
  PROCESSED_LABEL_NAME, type EmailDetails } from './gmail';
import { logEvent, type Counts, type Stage } from './logger';

export async function findInboxMessageIds(gmail: gmail_v1.Gmail, limit: number): Promise<string[]> {
  parseMaxEmails(String(limit));
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const result = await gmail.users.messages.list({
      userId: 'me', labelIds: ['INBOX'],
      q: `-label:"${PROCESSED_LABEL_NAME}" -in:sent -in:drafts -in:spam -in:trash`,
      maxResults: Math.min(500, limit - ids.size), pageToken,
    });
    for (const message of result.data.messages ?? []) {
      if (message.id) ids.add(message.id);
      if (ids.size >= limit) break;
    }
    pageToken = result.data.nextPageToken ?? undefined;
    if (pageToken && tokens.has(pageToken)) throw new Error('Repeated Gmail page token.');
    if (pageToken) tokens.add(pageToken);
  } while (pageToken && ids.size < limit);
  return [...ids];
}

export async function processInbox(options: {
  gmail: gmail_v1.Gmail;
  generateReply: (email: EmailDetails) => Promise<string>;
  maxEmails?: number;
}): Promise<Counts> {
  const { gmail, generateReply, maxEmails = MAX_EMAILS_PER_RUN } = options;
  parseMaxEmails(String(maxEmails));
  const processedLabelId = await findOrCreateLabelId(gmail, PROCESSED_LABEL_NAME);
  // ラベル更新で検索結果が変わる前に、上限件数分のIDを確定する。
  const ids = await findInboxMessageIds(gmail, maxEmails);
  const counts: Counts = { selected: ids.length, succeeded: 0, failed: 0, skipped: 0 };
  for (const id of ids) {
    let stage: Stage = 'fetch';
    try {
      const email = await getEmailDetails(gmail, id, processedLabelId);
      if (!email) { counts.skipped++; continue; }
      stage = 'generate';
      const reply = await generateReply(email);
      if (!reply.trim()) throw new Error('Empty reply.');
      stage = 'draft';
      await createGmailDraft(gmail, email, reply);
      stage = 'label';
      await gmail.users.messages.modify({ userId: 'me', id,
        requestBody: { addLabelIds: [processedLabelId] } });
      counts.succeeded++;
    } catch {
      counts.failed++;
      logEvent('email_failed', stage);
    }
  }
  logEvent('completed', undefined, counts);
  return counts;
}
