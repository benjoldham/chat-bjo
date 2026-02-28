import { randomUUID } from 'crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET =
  process.env.UPLOADS_BUCKET_NAME ||
  process.env.AMPLIFY_STORAGE_BUCKET_NAME ||
  process.env.STORAGE_BUCKET_NAME ||
  process.env.BUCKET_NAME ||
  '';

const s3 = new S3Client({ region: process.env.AWS_REGION });

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

const ALLOWED_CONTENT_TYPES = new Set([
  // text/code
  'text/plain',
  'text/markdown',
  'application/json',
  'application/x-yaml',
  'text/x-python',
  'text/javascript',
  'application/typescript',
  'text/typescript',
  // docs (MVP best-effort)
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // images
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

type Action =
  | { action: 'presign'; filename: string; contentType: string; sizeBytes: number }
  | { action: 'ingest'; s3Key: string; contentType: string };

function safeBaseName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

async function readAllBytesFromS3(key: string) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
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

function chunkTextByLines(text: string, maxChars = 8000) {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let buf = '';

  for (const line of lines) {
    if ((buf + line + '\n').length > maxChars) {
      if (buf.trim()) chunks.push(buf);
      buf = '';
    }
    buf += line + '\n';
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

export const handler = async (event: any) => {
  if (!BUCKET) {
    throw new Error('Storage bucket env var not found. Ensure backend.storage is added and function has storage access.');
  }

  const identityId =
    event?.identity?.sub ||
    event?.identity?.username ||
    event?.identity?.claims?.sub;

  if (!identityId) {
    throw new Error('Not authenticated (missing identity).');
  }

  const args = event.arguments as Action;

  if (args.action === 'presign') {
    const { filename, contentType, sizeBytes } = args;

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Unsupported file type: ${contentType}`);
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_BYTES) {
      throw new Error(`File too large. Max is ${MAX_BYTES} bytes.`);
    }

    const attachmentId = randomUUID();
    const safeName = safeBaseName(filename);
    const s3Key = `tmp/${identityId}/${attachmentId}/${safeName}`;

    const put = new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, put, { expiresIn: 60 * 5 });

    return { attachmentId, s3Key, uploadUrl };
  }

  if (args.action === 'ingest') {
    const { s3Key, contentType } = args;

    if (!s3Key.startsWith(`tmp/${identityId}/`)) {
      throw new Error('Access denied for this key.');
    }

    // Images: store metadata only (chat function can fetch bytes later).
    if (contentType.startsWith('image/')) {
      const metaKey = `extracted/${identityId}/${encodeURIComponent(s3Key)}.json`;
      const payload = {
        kind: 'image',
        s3Key,
        contentType,
        createdAt: new Date().toISOString(),
      };

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: metaKey,
          ContentType: 'application/json',
          Body: JSON.stringify(payload),
        })
      );

      return { kind: 'image', metaKey };
    }

    // Text/code/docs (MVP best-effort UTF-8)
    const bytes = await readAllBytesFromS3(s3Key);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    const capped = text.slice(0, 300_000);
    const chunks = chunkTextByLines(capped, 8000);

    const metaKey = `extracted/${identityId}/${encodeURIComponent(s3Key)}.json`;
    const payload = {
      kind: 'text',
      s3Key,
      contentType,
      createdAt: new Date().toISOString(),
      textLength: capped.length,
      chunks,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: metaKey,
        ContentType: 'application/json',
        Body: JSON.stringify(payload),
      })
    );

    return { kind: 'text', metaKey, chunkCount: chunks.length };
  }

  throw new Error('Unknown action');
};
