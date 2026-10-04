import 'dotenv/config';

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { htmlToText } from 'html-to-text';
import { gmail_v1, google } from 'googleapis';
import OpenAI from 'openai';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
];

const CREDENTIALS_PATH = path.resolve('credentials.json');
const TOKEN_PATH = path.resolve('token.json');
const TARGET_LABEL_NAME = 'AI返信テスト';
const PROCESSED_LABEL_NAME = 'AI処理済み';
const MAX_BODY_CHARS = 6000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

type OAuthClientConfig = {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
};

type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

type EmailDetails = {
  gmailMessageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  rfcMessageId: string;
  references: string;
  body: string;
};

async function main(): Promise<void> {
  console.log('Gmail問い合わせ返信テストを開始します。');

  validateEnvironment();

  console.log('Google OAuth 2.0認証を確認しています。');
  const auth = await authorize();
  const gmail = google.gmail({ version: 'v1', auth });

  console.log('Gmailラベルを確認しています。');
  const targetLabelId = await findRequiredLabelId(gmail, TARGET_LABEL_NAME);
  const processedLabelId = await findOrCreateLabelId(gmail, PROCESSED_LABEL_NAME);

  console.log('対象メールを検索しています。');
  const messageId = await findOneUnreadTargetMessageId(gmail, targetLabelId);
  if (!messageId) {
    console.log('対象メールはありません。「AI返信テスト」ラベル付きの未読メールを1件用意してください。');
    return;
  }

  console.log(`対象メールを取得しています。Gmail messageId: ${messageId}`);
  const email = await getEmailDetails(gmail, messageId);
  console.log(`送信者: ${email.from}`);
  console.log(`件名: ${email.subject}`);
  console.log(`threadId: ${email.threadId}`);
  console.log(`RFC Message-ID: ${email.rfcMessageId || '取得できませんでした'}`);

  console.log('OpenAI APIで返信案を作成しています。');
  const replyText = await createReplyDraftText(email);

  console.log('元スレッドに返信下書きを保存しています。');
  const draftId = await createGmailDraft(gmail, email, replyText);

  console.log('処理済みラベルを付けています。');
  await gmail.users.messages.modify({
    userId: 'me',
    id: email.gmailMessageId,
    requestBody: {
      addLabelIds: [processedLabelId],
    },
  });

  console.log(`処理が完了しました。Gmailの下書きを確認してください。draftId: ${draftId}`);
}

function validateEnvironment(): void {
  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!process.env.OPENAI_MODEL) missing.push('OPENAI_MODEL');

  if (missing.length > 0) {
    throw new Error(`.envに必要な環境変数がありません: ${missing.join(', ')}`);
  }
}

async function authorize(): Promise<OAuthClient> {
  const config = await readOAuthClientConfig();
  const cachedClient = createOAuthClient(config, config.redirectUris[0] ?? 'http://localhost');
  const cachedToken = await readJsonIfExists(TOKEN_PATH);
  if (cachedToken) {
    cachedClient.setCredentials(cachedToken as Parameters<OAuthClient['setCredentials']>[0]);
    return cachedClient;
  }

  return runLocalOAuthFlow(config);
}

async function readOAuthClientConfig(): Promise<OAuthClientConfig> {
  const file = await fs.readFile(CREDENTIALS_PATH, 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error('credentials.jsonが見つかりません。Google Cloudからダウンロードして配置してください。');
    }
    throw error;
  });
  const credentials = JSON.parse(file) as {
    installed?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
    web?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
  };
  const client = credentials.installed ?? credentials.web;

  if (!client?.client_id || !client.client_secret) {
    throw new Error('credentials.jsonからOAuthクライアント情報を読み取れませんでした。');
  }

  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUris: client.redirect_uris ?? [],
  };
}

function createOAuthClient(config: OAuthClientConfig, redirectUri: string): OAuthClient {
  return new google.auth.OAuth2(config.clientId, config.clientSecret, redirectUri);
}

async function runLocalOAuthFlow(config: OAuthClientConfig): Promise<OAuthClient> {
  const state = randomBytes(16).toString('hex');
  const { server, codePromise, redirectUri } = await startOAuthCallbackServer(state);
  const auth = createOAuthClient(config, redirectUri);
  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });

  console.log('初回認証が必要です。次のURLをブラウザで開いてGoogle認証を完了してください。');
  console.log(authUrl);

  try {
    const code = await codePromise;
    const tokenResponse = await auth.getToken(code);
    auth.setCredentials(tokenResponse.tokens);
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokenResponse.tokens, null, 2), 'utf8');
  } finally {
    server.close();
  }

  console.log('OAuthトークンをtoken.jsonに保存しました。');
  return auth;
}

async function startOAuthCallbackServer(state: string): Promise<{
  server: ReturnType<typeof createServer>;
  codePromise: Promise<string>;
  redirectUri: string;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const timeout = setTimeout(() => {
    rejectCode(new Error('OAuth認証がタイムアウトしました。再実行してください。'));
  }, AUTH_TIMEOUT_MS);

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const code = requestUrl.searchParams.get('code');
      const requestState = requestUrl.searchParams.get('state');
      const error = requestUrl.searchParams.get('error');

      if (error) {
        throw new Error(`Google認証でエラーが返されました: ${error}`);
      }
      if (requestState !== state) {
        throw new Error('OAuth stateが一致しません。認証をやり直してください。');
      }
      if (!code) {
        throw new Error('OAuth認証コードを取得できませんでした。');
      }

      clearTimeout(timeout);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('認証が完了しました。このブラウザタブは閉じても大丈夫です。');
      resolveCode(code);
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`認証に失敗しました: ${message}`);
      rejectCode(error instanceof Error ? error : new Error(message));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('OAuth認証用のローカルサーバーを開始できませんでした。');
  }

  return {
    server,
    codePromise,
    redirectUri: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const file = await fs.readFile(filePath, 'utf8');
    return JSON.parse(file) as Record<string, unknown>;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function findRequiredLabelId(gmail: gmail_v1.Gmail, labelName: string): Promise<string> {
  const labelId = await findLabelId(gmail, labelName);
  if (!labelId) {
    throw new Error(`Gmailラベル「${labelName}」が見つかりません。先にGmailで作成してください。`);
  }
  return labelId;
}

async function findOrCreateLabelId(gmail: gmail_v1.Gmail, labelName: string): Promise<string> {
  const existingLabelId = await findLabelId(gmail, labelName);
  if (existingLabelId) {
    return existingLabelId;
  }

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });

  const labelId = created.data.id;
  if (!labelId) {
    throw new Error(`Gmailラベル「${labelName}」を作成できませんでした。`);
  }

  console.log(`Gmailラベル「${labelName}」を作成しました。`);
  return labelId;
}

async function findLabelId(gmail: gmail_v1.Gmail, labelName: string): Promise<string | null> {
  const labels = await gmail.users.labels.list({ userId: 'me' });
  const label = labels.data.labels?.find((item) => item.name === labelName);
  return label?.id ?? null;
}

async function findOneUnreadTargetMessageId(
  gmail: gmail_v1.Gmail,
  targetLabelId: string,
): Promise<string | null> {
  const result = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [targetLabelId, 'UNREAD'],
    q: `-label:"${PROCESSED_LABEL_NAME}"`,
    maxResults: 1,
  });

  return result.data.messages?.[0]?.id ?? null;
}

async function getEmailDetails(gmail: gmail_v1.Gmail, messageId: string): Promise<EmailDetails> {
  const result = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = result.data;
  if (!message.id || !message.threadId || !message.payload) {
    throw new Error('メールの基本情報を取得できませんでした。');
  }

  const headers = message.payload.headers ?? [];
  const from = getHeader(headers, 'From');
  const to = getHeader(headers, 'To');
  const subject = getHeader(headers, 'Subject') || '(件名なし)';
  const rfcMessageId = getHeader(headers, 'Message-ID');
  const references = getHeader(headers, 'References');
  const body = extractMessageBody(message.payload);

  if (!from) {
    throw new Error('送信者を取得できませんでした。');
  }
  if (!body) {
    throw new Error('メール本文を抽出できませんでした。');
  }

  return {
    gmailMessageId: message.id,
    threadId: message.threadId,
    from,
    to,
    subject,
    rfcMessageId,
    references,
    body,
  };
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractMessageBody(payload: gmail_v1.Schema$MessagePart): string {
  const parts = flattenParts(payload);
  const plainPart = parts.find((part) => part.mimeType === 'text/plain' && part.body?.data);
  if (plainPart?.body?.data) {
    return cleanBody(decodeBase64Url(plainPart.body.data));
  }

  const htmlPart = parts.find((part) => part.mimeType === 'text/html' && part.body?.data);
  if (htmlPart?.body?.data) {
    return cleanBody(
      htmlToText(decodeBase64Url(htmlPart.body.data), {
        wordwrap: false,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
        ],
      }),
    );
  }

  return '';
}

function flattenParts(part: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart[] {
  const children = part.parts ?? [];
  return [part, ...children.flatMap((child) => flattenParts(child))];
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function cleanBody(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function createReplyDraftText(email: EmailDetails): Promise<string> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL as string,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'あなたは小規模ネットショップの問い合わせ担当者です。問い合わせへの返信案を丁寧な日本語で作成してください。不明な配送状況、料金、返金、在庫、納期は断定しないでください。判断できない場合は、担当者が確認して改めて連絡すると案内してください。返信は200～400文字程度にしてください。',
      },
      {
        role: 'user',
        content: [
          '次の問い合わせメールへの返信案を作成してください。',
          `送信者: ${email.from}`,
          `件名: ${email.subject}`,
          '本文:',
          email.body.slice(0, MAX_BODY_CHARS),
        ].join('\n'),
      },
    ],
  });

  const reply = completion.choices[0]?.message.content?.trim();
  if (!reply) {
    throw new Error('OpenAI APIから返信案を取得できませんでした。');
  }

  return reply;
}

async function createGmailDraft(
  gmail: gmail_v1.Gmail,
  email: EmailDetails,
  replyText: string,
): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const fromAddress = profile.data.emailAddress;
  if (!fromAddress) {
    throw new Error('Gmailアカウントのメールアドレスを取得できませんでした。');
  }

  const raw = buildRawReplyMessage(email, replyText, fromAddress);
  const result = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId: email.threadId,
      },
    },
  });

  const draftId = result.data.id;
  if (!draftId) {
    throw new Error('Gmailの下書きを作成できませんでした。');
  }

  return draftId;
}

function buildRawReplyMessage(email: EmailDetails, replyText: string, fromAddress: string): string {
  const subject = email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`;
  const referenceHeaders = buildReferenceHeaders(email);
  const body = Buffer.from(replyText, 'utf8').toString('base64');
  const headers = [
    `To: ${email.from}`,
    `From: ${fromAddress}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    ...referenceHeaders,
  ].filter(Boolean);

  const rawMessage = `${headers.join('\r\n')}\r\n\r\n${wrapBase64(body)}`;
  return Buffer.from(rawMessage, 'utf8').toString('base64url');
}

function buildReferenceHeaders(email: EmailDetails): string[] {
  if (!email.rfcMessageId) {
    return [];
  }

  const references = email.references
    ? `${email.references} ${email.rfcMessageId}`
    : email.rfcMessageId;

  return [`In-Reply-To: ${email.rfcMessageId}`, `References: ${references}`];
}

function encodeMimeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`エラーが発生しました: ${message}`);
  console.error('メールの削除や送信は行っていません。原因を確認してから再実行してください。');
  process.exitCode = 1;
});
