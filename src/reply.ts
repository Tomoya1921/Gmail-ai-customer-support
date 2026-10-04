import type OpenAI from 'openai';
import type { EmailDetails } from './gmail';

const MAX_BODY_CHARS = 6000;

export async function createReplyDraftText(email: EmailDetails, client: OpenAI, model: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
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
