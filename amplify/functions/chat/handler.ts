import type { Schema } from '../../data/resource';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

export const handler: Schema['chat']['functionHandler'] = async (event) => {
  const { prompt } = event.arguments;

  // Pick a model you have access to in Bedrock (we can change later).
  // Common options: Anthropic Claude, Amazon Titan, etc.
  const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 800,
    temperature: 0.7,
    messages: [
      { role: 'user', content: prompt },
    ],
  });

  const resp = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    })
  );

  const json = JSON.parse(new TextDecoder().decode(resp.body));
  const text =
    json?.content?.map((c: any) => c?.text).filter(Boolean).join('') ??
    json?.completion ??
    '';

  return { text };
};
