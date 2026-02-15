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
  deepseek: 'deepseek.v3.2',
};

export const handler: Schema['chat']['functionHandler'] = async (event) => {
 const { prompt, modelKey, history } = event.arguments as {
  prompt: string;
  modelKey?: string;
  history?: string;
};

  const resolvedKey = modelKey && MODEL_MAP[modelKey] ? modelKey : 'claude_haiku';
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
      maxTokens: 800,
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

  return { text };
};
