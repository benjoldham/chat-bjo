import type { Schema } from '../../data/resource';
import { randomUUID } from 'crypto';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const bedrockConverseClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

// Nova Canvas is invoked via InvokeModel in the region where Canvas is enabled (eu-west-1).
const canvasRegion = process.env.BEDROCK_CANVAS_REGION || 'eu-west-1';
const bedrockCanvasClient = new BedrockRuntimeClient({ region: canvasRegion });

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
  nova_canvas: 'amazon.nova-canvas-v1:0',
};

const SUPPORTS_VISION: Record<string, boolean> = {
  claude_haiku: true,
  claude_sonnet: true,
  google_gemma: false,
  openai: false,
  meta: false,
  nova_canvas: false,
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

  console.log('CHAT_HANDLER_HIT', {
    hasPrompt: !!(event as any)?.arguments?.prompt,
    modelKey: (event as any)?.arguments?.modelKey,
    region: process.env.AWS_REGION,
    canvasRegion: process.env.BEDROCK_CANVAS_REGION,
  });

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

    // ===== Nova Canvas (image generation) path =====
  if (resolvedKey === 'nova_canvas') {
    // Nova Canvas uses InvokeModel (not Converse) and must be called in the region where it is enabled.
    // Request/response structure per AWS docs. :contentReference[oaicite:1]{index=1}
    // Extract only the last user message for image generation.
    // NOTE: `history` arrives as a JSON string from the client.
    let historyArr: any[] = [];
    try {
      historyArr = typeof history === 'string' && history.trim().length > 0 ? JSON.parse(history) : [];
    } catch (e) {
      console.error('Failed to parse history JSON for nova_canvas:', { historyType: typeof history });
      historyArr = [];
    }

    const lastUserMessage =
      historyArr
        .filter((m: any) => m?.role === 'user')
        .at(-1)?.content ?? '';

    const baseFromHistory = String(lastUserMessage).replace(/\s+/g, ' ').trim();
    const baseFromPrompt = String(prompt ?? '').replace(/\s+/g, ' ').trim();

    // Prefer the raw prompt (page.tsx sends user text + [nova ...] directives when Nova is selected),
    // otherwise fall back to last user message from history.
    const raw = baseFromPrompt || baseFromHistory;

    if (!raw) {
      return {
        text: '⚠️ No prompt text was provided for image generation.',
        stopReason: 'error',
      };
    }

    // ---- Parse Nova directives: [nova quality:premium size:2048 ar:16:9 images:2 seed:123 style:photoreal] ----
    const novaTag = /\[\s*nova\s+([^\]]+)\]/i;
    const m = raw.match(novaTag);
    const directiveStr = m?.[1] ?? '';

    const get = (key: string) => {
      const r = new RegExp(`${key}\\s*:\\s*([^\\s]+)`, 'i');
      return directiveStr.match(r)?.[1] ?? null;
    };

    const qualityRaw = (get('quality') ?? 'standard').toLowerCase();
    const sizeRaw = Number.parseInt(get('size') ?? '1024', 10);
    const imagesRaw = Number.parseInt(get('images') ?? '1', 10);
    const seedRaw = get('seed');
    const styleRaw = (get('style') ?? 'none').toLowerCase();
    const arRaw = (get('ar') ?? '1:1').toLowerCase();

    const novaQuality = qualityRaw === 'premium' ? 'premium' : 'standard';
    const novaSize = sizeRaw === 2048 ? 2048 : 1024;
    const novaImages = imagesRaw === 2 ? 2 : 1;

    const seedOverride = seedRaw ? Number.parseInt(seedRaw, 10) : null;
    const seed =
      Number.isFinite(seedOverride) && seedOverride !== null
        ? seedOverride
        : Math.floor(Math.random() * 858_993_460);

    // Remove the [nova ...] tag before sending to the model
    let userText = raw.replace(novaTag, '').trim();

    // Optional style hint: prefix the prompt (simple + predictable)
    if (styleRaw && styleRaw !== 'none') {
      const stylePrefix =
        styleRaw === 'photoreal'
          ? 'Photorealistic, '
          : styleRaw === 'illustration'
          ? 'Illustration, '
          : styleRaw === '3d'
          ? '3D render, '
          : styleRaw === 'anime'
          ? 'Anime style, '
          : '';
      if (stylePrefix) userText = stylePrefix + userText;
    }

    // Aspect ratio mapping based on selected size:
    // 1:1 => size x size
    // 16:9 => size x round(size*9/16)
    // 9:16 => round(size*9/16) x size
    let width = novaSize;
    let height = novaSize;

    if (arRaw === '16:9') {
      width = novaSize;
      height = Math.round((novaSize * 9) / 16);
    } else if (arRaw === '9:16') {
      width = Math.round((novaSize * 9) / 16);
      height = novaSize;
    }

    // Nova prompt must be <= 1024 chars
    const limitedPrompt = userText.slice(0, 1024);

    // Optional debug – remove once verified
    console.log('NOVA_OPTS:', { novaQuality, width, height, novaImages, seed, styleRaw, arRaw });
    console.log('NOVA_PROMPT_SENT:', limitedPrompt);

    const payload = {
      taskType: 'TEXT_IMAGE',
      textToImageParams: { text: limitedPrompt },
      imageGenerationConfig: {
        seed,
        quality: novaQuality,
        width,
        height,
        numberOfImages: novaImages,
      },
    };

    const response = await bedrockCanvasClient.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      })
    );

    const decoded = new TextDecoder().decode(response.body);
const json = JSON.parse(decoded) as { images?: string[] };

const images = (json.images ?? []).filter((b64) => typeof b64 === 'string' && b64.trim().length > 0);

if (images.length === 0) {
  console.error('Nova Canvas returned empty image payload:', json);
  return {
    text: '⚠️ Image generation failed. Please try again.',
    stopReason: 'error',
  };
}

if (!BUCKET) {
  console.error('No S3 bucket env var found for saving generated images.');
  return { text: '⚠️ Storage is not configured for generated images.', stopReason: 'error' };
}

// Upload + presign each image, then return markdown with all of them
const urls: string[] = [];

for (let i = 0; i < images.length; i++) {
  const base64 = images[i];

  const bytes = Buffer.from(base64, 'base64');
  const key = `generated/nova-canvas/${randomUUID()}-${i + 1}.png`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: 60 * 60 * 24 * 7 } // 7 Days
  );

  urls.push(url);
}

const md = urls.map((u, i) => `![Nova Canvas image ${i + 1}](${u})`).join('\n\n');
return { text: md, stopReason: 'image_generated' };

  }
  // ===== end Nova Canvas path =====

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
      resp = await bedrockConverseClient.send(new ConverseCommand(input));
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