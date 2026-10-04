import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { gmail_v1 } from 'googleapis';
import type OpenAI from 'openai';
import { parseMaxEmails, readConfig } from '../src/config';
import { createGmailDraft, getEmailDetails, PROCESSED_LABEL_NAME } from '../src/gmail';
import { findInboxMessageIds, processInbox } from '../src/processInbox';
import { createReplyDraftText } from '../src/reply';

const email = {
  gmailMessageId: 'fictional-1', threadId: 'fictional-thread',
  from: 'customer@example.invalid', to: 'support@example.invalid',
  subject: '架空の問い合わせ', rfcMessageId: '<fictional@example.invalid>',
  references: '<previous@example.invalid>', body: '架空の問い合わせ本文',
};

function fixture(count = 7, failure?: string) {
  const calls: string[] = [];
  const drafts: any[] = [];
  const searches: any[] = [];
  const ids = Array.from({ length: count }, (_, i) => `fictional-${i + 1}`);
  const message = (id: string) => ({
    id, threadId: email.threadId,
    labelIds: id.endsWith('1') ? ['INBOX', 'UNREAD'] : ['INBOX'],
    payload: { mimeType: 'text/plain',
      headers: [ { name: 'From', value: email.from }, { name: 'Subject', value: email.subject },
        { name: 'Message-ID', value: email.rfcMessageId }, { name: 'References', value: email.references } ],
      body: { data: Buffer.from(email.body).toString('base64url') },
    },
  });
  const raw = { users: {
    labels: {
      list: async () => ({ data: { labels: [{ id: 'processed', name: PROCESSED_LABEL_NAME }] } }),
      create: async () => ({ data: { id: 'processed' } }),
    },
    messages: {
      list: async (args: any) => {
        searches.push(args); calls.push('list');
        const start = Number(args.pageToken ?? 0);
        const page = ids.slice(start, start + Math.min(2, args.maxResults));
        return { data: { messages: page.map(id => ({ id })),
          nextPageToken: start + page.length < count ? String(start + page.length) : undefined } };
      },
      get: async ({ id }: any) => {
        calls.push(`get:${id}`);
        if (failure === 'fetch' && id.endsWith('1')) throw new Error(email.body);
        const data = message(id);
        if (failure === 'processed') data.labelIds.push('processed');
        if (failure === 'outside') data.labelIds = ['ARCHIVED'];
        return { data };
      },
      modify: async ({ id, requestBody }: any) => {
        calls.push(`label:${id}`);
        assert.deepEqual(requestBody, { addLabelIds: ['processed'] });
        if (failure === 'label' && id.endsWith('1')) throw new Error(email.from);
        return { data: {} };
      },
    },
    getProfile: async () => ({ data: { emailAddress: email.to } }),
    drafts: { create: async (args: any) => {
      calls.push('draft'); drafts.push(args);
      if (failure === 'draft' && drafts.length === 1) throw new Error('fictional-secret');
      if (failure === 'missingDraftId') return { data: {} };
      return { data: { id: 'fictional-draft' } };
    } },
  } };
  const gmail = raw as unknown as gmail_v1.Gmail;
  let generations = 0;
  const generateReply = async () => {
    calls.push('generate'); generations++;
    if (failure === 'generate' && generations === 1) throw new Error(email.body);
    return failure === 'empty' ? ' ' : '架空の返信です。';
  };
  return { gmail, raw, calls, searches, drafts, generateReply };
}

test('上限の初期値・変更・不正値と必須設定を検証する', () => {
  assert.equal(parseMaxEmails(), 5);
  assert.equal(parseMaxEmails('2'), 2);
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', ' 5', '1e3', '9007199254740992']) {
    assert.throws(() => parseMaxEmails(value));
  }
  assert.throws(() => readConfig({}));
  assert.equal(readConfig({ OPENAI_API_KEY: 'fictional', OPENAI_MODEL: 'fictional' }).maxEmails, 5);
});

test('既読・未読を問わず最大5件、全ID確定後に下書き→ラベルの順で処理', async () => {
  const f = fixture();
  assert.deepEqual(await processInbox(f), { selected: 5, succeeded: 5, failed: 0, skipped: 0 });
  assert.equal(f.calls.filter(c => c === 'generate').length, 5);
  assert.equal(f.drafts.length, 5);
  assert.deepEqual(f.calls.slice(0, 3), ['list', 'list', 'list']);
  assert.equal(f.searches[2].maxResults, 1);
  for (const search of f.searches) {
    assert.deepEqual(search.labelIds, ['INBOX']);
    assert.ok(search.q.includes(`-label:"${PROCESSED_LABEL_NAME}"`));
    assert.ok(!/unread|AI返信テスト/i.test(search.q));
  }
  for (let i = 0; i < f.calls.length; i++) {
    if (f.calls[i].startsWith('label:')) assert.equal(f.calls[i - 1], 'draft');
  }
  const draft = f.drafts[0].requestBody.message;
  assert.equal(draft.threadId, email.threadId);
  const decoded = Buffer.from(draft.raw, 'base64url').toString('utf8');
  assert.ok(decoded.includes(`In-Reply-To: ${email.rfcMessageId}`));
  assert.ok(decoded.includes(`References: ${email.references} ${email.rfcMessageId}`));
});

test('変更した上限と0件を扱う', async () => {
  assert.equal((await processInbox({ ...fixture(), maxEmails: 2 })).selected, 2);
  const f = fixture(0);
  assert.equal((await processInbox(f)).selected, 0);
  assert.ok(!f.calls.includes('generate'));
});

test('全件失敗でも5件を超えて返信生成せず、追加補充しない', async () => {
  const f = fixture(10);
  let attempts = 0;
  const result = await processInbox({ ...f, generateReply: async () => {
    attempts++;
    throw new Error('fictional failure');
  } });
  assert.equal(attempts, 5);
  assert.equal(result.failed, 5);
  assert.equal(f.drafts.length, 0);
});

test('一覧取得失敗時は返信生成も下書き作成もしない', async () => {
  const f = fixture();
  f.raw.users.messages.list = async () => { throw new Error('fictional failure'); };
  await assert.rejects(processInbox(f));
  assert.ok(!f.calls.includes('generate'));
  assert.equal(f.drafts.length, 0);
});

test('送信・削除・ゴミ箱移動APIは呼ばない', async () => {
  const f = fixture(2);
  let forbiddenCalls = 0;
  const forbidden = async () => { forbiddenCalls++; throw new Error('Forbidden operation'); };
  Object.assign(f.raw.users.messages, { send: forbidden, delete: forbidden,
    trash: forbidden, batchDelete: forbidden });
  Object.assign(f.raw.users.drafts, { send: forbidden, delete: forbidden });
  assert.equal((await processInbox(f)).succeeded, 2);
  assert.equal(forbiddenCalls, 0);
});

for (const stage of ['fetch', 'generate', 'draft', 'label']) {
  test(`${stage}失敗後も次のメールを処理し、生エラーをログに出さない`, async (t) => {
    const logs: string[] = [];
    t.mock.method(console, 'log', (value: string) => logs.push(value));
    const f = fixture(2, stage);
    assert.deepEqual(await processInbox(f), { selected: 2, succeeded: 1, failed: 1, skipped: 0 });
    assert.ok(f.calls.includes('label:fictional-2'));
    if (stage !== 'label') assert.ok(!f.calls.includes('label:fictional-1'));
    const output = logs.join('\n');
    assert.ok(output.includes(`"stage":"${stage}"`));
    for (const secret of [email.from, email.body, email.subject, 'fictional-secret', email.rfcMessageId]) {
      assert.ok(!output.includes(secret));
    }
  });
}

for (const reason of ['processed', 'outside']) {
  test(`${reason}のメールは取得時にも除外する`, async () => {
    const f = fixture(2, reason);
    assert.equal((await processInbox(f)).skipped, 2);
    assert.ok(!f.calls.includes('generate'));
  });
}

for (const failure of ['empty', 'missingDraftId']) {
  test(`${failure}の場合は処理済みにしない`, async () => {
    const f = fixture(1, failure);
    assert.equal((await processInbox(f)).failed, 1);
    assert.ok(!f.calls.some(c => c.startsWith('label:')));
  });
}

test('重複IDを除去し、繰り返すページトークンでは停止する', async () => {
  const f = fixture();
  let page = 0;
  f.raw.users.messages.list = async () => ({ data: {
    messages: [{ id: 'same' }], nextPageToken: ++page < 2 ? 'next' : undefined,
  } });
  assert.deepEqual(await findInboxMessageIds(f.gmail, 5), ['same']);
  f.raw.users.messages.list = async () => ({ data: { messages: [], nextPageToken: 'repeat' } });
  await assert.rejects(findInboxMessageIds(f.gmail, 5));
});

test('HTML本文の抽出と不正ヘッダーの拒否', async () => {
  const f = fixture();
  f.raw.users.messages.get = async () => ({ data: {
    id: 'fictional', threadId: 'fictional-thread', labelIds: ['INBOX'],
    payload: { mimeType: 'text/html', headers: [{ name: 'From', value: email.from }],
      body: { data: Buffer.from('<p>架空の本文</p>').toString('base64url') } },
  } });
  assert.equal((await getEmailDetails(f.gmail, 'fictional', 'processed'))?.body, '架空の本文');
  await assert.rejects(createGmailDraft(f.gmail, { ...email, from: 'x\r\nBcc: bad' }, 'reply'));
  assert.equal(f.drafts.length, 0);
});

test('OpenAI入力と返信検証をモックで確認する', async () => {
  let request: any;
  const client = { chat: { completions: { create: async (args: any) => {
    request = args; return { choices: [{ message: { content: ' 架空の返信 ' } }] };
  } } } };
  assert.equal(await createReplyDraftText(email, client as unknown as OpenAI, 'fictional-model'), '架空の返信');
  assert.equal(request.model, 'fictional-model');
  assert.ok(request.messages[1].content.includes(email.body));
  assert.ok(!request.messages[1].content.includes(email.from));
  client.chat.completions.create = async () => ({ choices: [{ message: { content: ' ' } }] });
  await assert.rejects(createReplyDraftText(email, client as unknown as OpenAI, 'fictional-model'));
});
