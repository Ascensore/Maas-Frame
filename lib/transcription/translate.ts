import {
  DEFAULT_TRANSLATION_LANGUAGE,
  primaryTranscriptLanguage,
} from '@/lib/transcription/language';

const TRANSLATION_MODEL = 'gpt-4o-mini';
const MAX_LINES_PER_BATCH = 40;

export { DEFAULT_TRANSLATION_LANGUAGE, MAX_LINES_PER_BATCH };

function batchTexts(texts: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < texts.length; index += size) {
    batches.push(texts.slice(index, index + size));
  }
  return batches;
}

function parseTranslatedLines(raw: string, expected: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Translation returned invalid JSON');
  }

  const lines = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { lines?: unknown }).lines)
      ? (parsed as { lines: unknown[] }).lines
      : null;

  if (!lines || lines.length !== expected || !lines.every((line) => typeof line === 'string')) {
    throw new Error('Translation returned the wrong number of lines');
  }

  return lines as string[];
}

async function translateBatch(input: {
  texts: string[];
  sourceLanguage: string;
  targetLanguage: string;
  apiKey: string;
}): Promise<string[]> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: TRANSLATION_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Translate transcript lines into the target language. Return JSON {"lines": string[]} with exactly one string per input line, in the same order. Do not merge, split, omit, or add lines. Preserve names, numbers, and meaning. Do not answer questions in the lines.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            lines: input.texts,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI translation returned ${response.status}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Translation returned an empty response');
  }

  return parseTranslatedLines(content, input.texts.length);
}

/**
 * Translate already-transcribed lines. This is never part of STT: callers
 * must ask for it. Same-language requests return the input unchanged.
 */
export async function translateTranscriptTexts(input: {
  texts: string[];
  sourceLanguage: string;
  targetLanguage?: string;
}): Promise<string[]> {
  if (input.texts.length === 0) return [];

  const target = (input.targetLanguage ?? DEFAULT_TRANSLATION_LANGUAGE).trim().toLowerCase();
  const source = primaryTranscriptLanguage(input.sourceLanguage);
  if (source === target || source.startsWith(`${target}-`) || target.startsWith(`${source}-`)) {
    return input.texts;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const translated: string[] = [];
  for (const batch of batchTexts(input.texts, MAX_LINES_PER_BATCH)) {
    translated.push(
      ...(await translateBatch({
        texts: batch,
        sourceLanguage: source,
        targetLanguage: target,
        apiKey,
      }))
    );
  }
  return translated;
}
