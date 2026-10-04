export const MAX_EMAILS_PER_RUN = 5;

export function parseMaxEmails(value?: string): number {
  if (value === undefined) return MAX_EMAILS_PER_RUN;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('MAX_EMAILS_PER_RUN must be a positive safe integer.');
  }
  return Number(value);
}

export function readConfig(env: NodeJS.ProcessEnv) {
  if (!env.OPENAI_API_KEY?.trim() || !env.OPENAI_MODEL?.trim()) {
    throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required.');
  }
  return { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL,
    maxEmails: parseMaxEmails(env.MAX_EMAILS_PER_RUN) };
}
