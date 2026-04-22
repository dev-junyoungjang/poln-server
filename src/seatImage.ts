import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const BUCKET = process.env.SEAT_IMAGES_BUCKET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const KEY_PREFIX = 'seat-image/';
const CONVERTED_PREFIX = 'seat-image-converted/';
const UPLOAD_URL_TTL_SECONDS = 300;

const s3 = new S3Client({
  region: REGION,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function corsHeaders(origin?: string) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  origin?: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function isAdmin(event: APIGatewayProxyEvent): boolean {
  if (!ADMIN_KEY) return false;
  const headers = event.headers || {};
  const key = headers['x-admin-key'] || headers['X-Admin-Key'] || headers['x-Admin-Key'];
  return key === ADMIN_KEY;
}

function publicUrlForKey(key: string): string {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function listKeys(prefix: string): Promise<string[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix })
  );
  return (result.Contents || [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k);
}

function baseKeyPrefix(tournamentId: string): string {
  return `${KEY_PREFIX}${tournamentId}.`;
}

function roundKeyPrefix(tournamentId: string, round: number): string {
  return `${KEY_PREFIX}${tournamentId}_${round}.`;
}

async function findExistingKeys(prefix: string): Promise<string[]> {
  return listKeys(prefix);
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

// Given an original (WRITE_PREFIX) key, return the converted-equivalent URL
// if it exists in CONVERTED_PREFIX, otherwise the original URL.
async function convertedOrOriginalUrl(originalKey: string): Promise<string> {
  const convertedKey =
    CONVERTED_PREFIX + originalKey.substring(KEY_PREFIX.length);
  const exists = await objectExists(convertedKey);
  return publicUrlForKey(exists ? convertedKey : originalKey);
}

// Find the round-specific key with the largest round number <= upToRound.
async function findBestRoundKey(
  tournamentId: string,
  upToRound: number
): Promise<string | null> {
  const keys = await listKeys(`${KEY_PREFIX}${tournamentId}_`);
  let bestRound = -1;
  let bestKey: string | null = null;
  const pattern = new RegExp(`_(\\d+)\\.[^.]+$`);
  for (const key of keys) {
    const m = key.match(pattern);
    if (!m) continue;
    const r = parseInt(m[1], 10);
    if (Number.isFinite(r) && r <= upToRound && r > bestRound) {
      bestRound = r;
      bestKey = key;
    }
  }
  return bestKey;
}

// GET /api/tournament/seat-image?tournamentId={id}
export async function getSeatImage(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    const tournamentId = event.queryStringParameters?.tournamentId;
    if (!tournamentId) {
      return jsonResponse(400, { error: 'tournamentId is required' }, origin);
    }

    const roundStr = event.queryStringParameters?.round;
    const round = roundStr ? parseInt(roundStr, 10) : NaN;

    if (Number.isFinite(round)) {
      const roundKey = await findBestRoundKey(tournamentId, round);
      if (roundKey) {
        return jsonResponse(
          200,
          { exists: true, url: await convertedOrOriginalUrl(roundKey) },
          origin
        );
      }
    }

    const baseKeys = await findExistingKeys(baseKeyPrefix(tournamentId));
    if (baseKeys.length === 0) {
      return jsonResponse(200, { exists: false, url: null }, origin);
    }

    return jsonResponse(
      200,
      { exists: true, url: await convertedOrOriginalUrl(baseKeys[0]) },
      origin
    );
  } catch (error) {
    console.error('Error checking seat image:', error);
    return jsonResponse(500, { error: 'Failed to check seat image' }, origin);
  }
}

// POST /api/tournament/seat-image/upload-url
// Headers: x-admin-key
// Body: { tournamentId, contentType }
export async function getSeatImageUploadUrl(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    if (!isAdmin(event)) {
      return jsonResponse(401, { error: 'Unauthorized' }, origin);
    }

    const body = JSON.parse(event.body || '{}');
    const { tournamentId, contentType, round } = body as {
      tournamentId?: string;
      contentType?: string;
      round?: number;
    };

    if (!tournamentId || !contentType) {
      return jsonResponse(
        400,
        { error: 'tournamentId and contentType are required' },
        origin
      );
    }

    if (round != null && !Number.isFinite(round)) {
      return jsonResponse(400, { error: 'round must be a number' }, origin);
    }

    const ext = ALLOWED_CONTENT_TYPES[contentType.toLowerCase()];
    if (!ext) {
      return jsonResponse(
        400,
        { error: 'Unsupported contentType. Allowed: image/png, image/jpeg, image/webp, image/svg+xml' },
        origin
      );
    }

    const slotPrefix =
      round != null ? roundKeyPrefix(tournamentId, round) : baseKeyPrefix(tournamentId);
    const convertedSlotPrefix =
      CONVERTED_PREFIX + slotPrefix.substring(KEY_PREFIX.length);
    const existing = [
      ...(await findExistingKeys(slotPrefix)),
      ...(await findExistingKeys(convertedSlotPrefix)),
    ];
    if (existing.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: existing.map((Key) => ({ Key })) },
        })
      );
    }

    const key = `${slotPrefix}${ext}`;
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS }
    );

    return jsonResponse(
      200,
      {
        uploadUrl,
        publicUrl: publicUrlForKey(key),
        key,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      },
      origin
    );
  } catch (error) {
    console.error('Error creating seat image upload URL:', error);
    return jsonResponse(500, { error: 'Failed to create upload URL' }, origin);
  }
}

// DELETE /api/tournament/seat-image?tournamentId={id}
// Headers: x-admin-key
export async function deleteSeatImage(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(origin), body: '' };
  }

  try {
    if (!isAdmin(event)) {
      return jsonResponse(401, { error: 'Unauthorized' }, origin);
    }

    const tournamentId = event.queryStringParameters?.tournamentId;
    if (!tournamentId) {
      return jsonResponse(400, { error: 'tournamentId is required' }, origin);
    }

    const roundStr = event.queryStringParameters?.round;
    const round = roundStr ? parseInt(roundStr, 10) : NaN;
    const prefix = Number.isFinite(round)
      ? roundKeyPrefix(tournamentId, round)
      : baseKeyPrefix(tournamentId);
    const convertedPrefix =
      CONVERTED_PREFIX + prefix.substring(KEY_PREFIX.length);
    const keys = [
      ...(await findExistingKeys(prefix)),
      ...(await findExistingKeys(convertedPrefix)),
    ];
    if (keys.length === 0) {
      return jsonResponse(200, { deleted: 0 }, origin);
    }

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      })
    );

    return jsonResponse(200, { deleted: keys.length }, origin);
  } catch (error) {
    console.error('Error deleting seat image:', error);
    return jsonResponse(500, { error: 'Failed to delete seat image' }, origin);
  }
}