import type { Schema } from '../../data/resource';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

const BUCKET =
  process.env.UPLOADS_BUCKET_NAME ||
  process.env.AMPLIFY_STORAGE_BUCKET_NAME ||
  process.env.STORAGE_BUCKET_NAME ||
  process.env.BUCKET_NAME ||
  '';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const sts = new STSClient({ region: process.env.AWS_REGION });

const MODEL_MAP: Record<string, string> = {
  // Keep your current default:
  claude_haiku: 'anthropic.claude-3-haiku-20240307-v1:0',
  claude_sonnet: 'global.anthropic.claude-sonnet-4-6',
  google_gemma: 'google.gemma-3-12b-it',
  openai: 'openai.gpt-oss-120b-1:0',
  meta: 'meta.llama3-70b-instruct-v1:0',
};

const SUPPORTS_VISION: Record<string, boolean> = {
  claude_haiku: true,
  claude_sonnet: true,
  google_gemma: false,
  openai: false,
  meta: false,
};

// Output token limits (tune for cost + UX). Can be overridden by env DEFAULT_MAX_OUTPUT_TOKENS.
const MAX_TOKENS_BY_MODELKEY: Record<string, number> = {
  claude_haiku: 2500,
  claude_sonnet: 2500,
  google_gemma: 2500,
  openai: 2500,
  meta: 2048,
};

const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.DEFAULT_MAX_OUTPUT_TOKENS ?? 2500);

// Hard safety cap to avoid accidental runaway costs.
// (Adjust if you later decide to allow more.)
const HARD_MAX_OUTPUT_TOKENS = 4000;

async function readAllBytes(bucket: string, key: string) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = obj.Body;
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  // @ts-ignore
  for await (const chunk of body) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function readJsonFromS3(bucket: string, key: string) {
  const bytes = await readAllBytes(bucket, key);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return JSON.parse(text);
}

function imageFormatFromContentType(ct: string): 'png' | 'jpeg' | 'gif' | 'webp' {
  if (ct === 'image/png') return 'png';
  if (ct === 'image/jpeg') return 'jpeg';
  if (ct === 'image/gif') return 'gif';
  return 'webp';
}

export const handler: Schema['chat']['functionHandler'] = async (event) => {
  const { prompt, modelKey, history, attachments } = event.arguments as {
  prompt: string;
  modelKey?: string;
  history?: string;
  attachments?: string;
};

  const fallbackKey = process.env.DEFAULT_MODEL_KEY ?? 'claude_haiku';
  const resolvedKey = modelKey && MODEL_MAP[modelKey] ? modelKey : fallbackKey;
  const modelId = MODEL_MAP[resolvedKey];
  console.log('modelKey:', modelKey, 'modelId:', modelId);

  try {
    const ident = await sts.send(new GetCallerIdentityCommand({}));
    console.log('callerIdentity:', {
      account: ident.Account,
      arn: ident.Arn,
      userId: ident.UserId,
      region: process.env.AWS_REGION,
    });
  } catch (e) {
    console.warn('GetCallerIdentity failed:', e);
  }

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
        messages: (() => {
      const baseMessages = parsedHistory
        ? parsedHistory.map((m) => ({
            role: m.role,
            content: [{ text: m.content }],
          }))
        : [
            {
              role: 'user',
              content: [{ text: prompt }],
            },
          ];

      if (!attachments || !BUCKET) return baseMessages;

      let parsed: Array<{ metaKey: string; kind: 'text' | 'image' }> = [];
      try {
        parsed = JSON.parse(attachments);
      } catch {
        return baseMessages;
      }
      if (!parsed.length) return baseMessages;

      const last = baseMessages[baseMessages.length - 1];
      if (!last || last.role !== 'user') return baseMessages;

      return (async () => {
        const extraBlocks: any[] = [];
        const visionOk = !!SUPPORTS_VISION[resolvedKey];
        const textContexts: string[] = [];

        for (const a of parsed) {
          try {
            const meta = await readJsonFromS3(BUCKET, a.metaKey);

            if (meta.kind === 'text') {
              const chunks: string[] = Array.isArray(meta.chunks) ? meta.chunks : [];
              const top = chunks.slice(0, 6).join('\n');
              textContexts.push(`File: ${meta.s3Key}\nContent (excerpt):\n${top}`.trim());
            }

            if (meta.kind === 'image' && visionOk) {
              const imgBytes = await readAllBytes(BUCKET, meta.s3Key);
              extraBlocks.push({
                image: {
                  format: imageFormatFromContentType(meta.contentType || 'image/png'),
                  source: { bytes: imgBytes },
                },
              });
            }
          } catch {
            // ignore broken attachment
          }
        }

        if (textContexts.length) {
          extraBlocks.unshift({
            text: `Attached files context:\n\n${textContexts.join('\n\n---\n\n')}`.trim(),
          });
        } else if (parsed.some((p) => p.kind === 'image') && !visionOk) {
          extraBlocks.unshift({
            text:
              `Note: You uploaded image(s), but the selected model can't view images. ` +
              `Switch to Claude (Haiku/Sonnet) to interpret screenshots.`,
          });
        }

        last.content = [...last.content, ...extraBlocks];
        return baseMessages;
      })() as any;
    })() as any,

    inferenceConfig: {
      maxTokens,
      temperature: 0.7,
    },
  };

  if (input.messages && typeof (input.messages as any).then === 'function') {
    input.messages = await (input.messages as any);
  }

  let resp;
  try {
    resp = await client.send(new ConverseCommand(input));
  } catch (e: any) {
    console.error('Bedrock ConverseCommand failed:', {
      name: e?.name,
      message: e?.message,
      $metadata: e?.$metadata,
    });
    throw e;
  }

  // Converse returns structured content blocks. Grab text blocks and join.
  const text =
    resp.output?.message?.content
      ?.map((c) => ('text' in c ? c.text : ''))
      .filter(Boolean)
      .join('') ?? '';

  return { text, stopReason: resp.stopReason ?? null };
};