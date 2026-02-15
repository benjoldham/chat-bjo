import type { Schema } from '../../data/resource';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

const MODEL_MAP: Record<string, string> = {
  // Keep your current default:
  claude_haiku: 'anthropic.claude-3-haiku-20240307-v1:0',
  openai: 'openai.gpt-oss-120b-1:0',
  meta: 'us.meta.llama3-1-70b-instruct-v1:0',
};

// Output token limits (tune for cost + UX). Can be overridden by env DEFAULT_MAX_OUTPUT_TOKENS.
const MAX_TOKENS_BY_MODELKEY: Record<string, number> = {
  claude_haiku: 2500,
  openai: 2500,
  meta: 2500,
};

const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.DEFAULT_MAX_OUTPUT_TOKENS ?? 2500);

// Hard safety cap to avoid accidental runaway costs.
// (Adjust if you later decide to allow more.)
const HARD_MAX_OUTPUT_TOKENS = 4000;

export const handler: Schema['chat']['functionHandler'] = async (event) => {
 const { prompt, modelKey, history } = event.arguments as {
  prompt: string;
  modelKey?: string;
  history?: string;
};

  const fallbackKey = process.env.DEFAULT_MODEL_KEY ?? 'claude_haiku';
  const resolvedKey = modelKey && MODEL_MAP[modelKey] ? modelKey : fallbackKey;
  const modelId = MODEL_MAP[resolvedKey];
  console.log('modelKey:', modelKey, 'modelId:', modelId);

  let parsedHistory: Array<{ role: 'user' | 'assistant'; content: string }> | null = null;
  if (history) {
    try {
      parsedHistory = JSON.parse(history);
    } catch {
      console.warn('Invalid history JSON, falling back to single prompt');
    }
  }

  const requestedMax =
    MAX_TOKENS_BY_MODELKEY[resolvedKey] ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const maxTokens = Math.min(
    Math.max(256, requestedMax), // minimum safety floor
    HARD_MAX_OUTPUT_TOKENS
  );

  const input: ConverseCommandInput = {
    modelId,
    messages: parsedHistory
      ? parsedHistory.map((m) => ({
          role: m.role,
          content: [{ text: m.content }],
        }))
      : [
          {
            role: 'user',
            content: [{ text: prompt }],
          },
        ],
    inferenceConfig: {
      maxTokens,
      temperature: 0.7,
    },
  };

  const resp = await client.send(new ConverseCommand(input));

  // Converse returns structured content blocks. Grab text blocks and join.
  const text =
    resp.output?.message?.content
      ?.map((c) => ('text' in c ? c.text : ''))
      .filter(Boolean)
      .join('') ?? '';

  return { text, stopReason: resp.stopReason ?? null };
};
