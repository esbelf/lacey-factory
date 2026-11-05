// Supplier documents in S3 (MinIO locally).
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { storageConfig } from "./config";

let client: S3Client | undefined;
let publicClient: S3Client | undefined;

function makeClient(endpoint: string | undefined) {
  return new S3Client({
    region: storageConfig().region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

function s3(): S3Client {
  client ??= makeClient(storageConfig().endpoint);
  return client;
}

/** Signs links with the host the browser uses (differs from the API's inside docker). */
function signer(): S3Client {
  const c = storageConfig();
  publicClient ??= c.publicEndpoint ? makeClient(c.publicEndpoint) : s3();
  return publicClient;
}

/** Idempotent: keys are content-addressed, so an existing object is left alone. */
export async function putDocument(key: string, body: Buffer, contentType: string) {
  const Bucket = storageConfig().bucket;
  try {
    await s3().send(new HeadObjectCommand({ Bucket, Key: key }));
    return;
  } catch {
    // not there yet
  }
  await s3().send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function getDocument(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: storageConfig().bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

/** Short-lived link for viewing a document in the browser. */
export async function documentUrl(key: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(signer(), new GetObjectCommand({ Bucket: storageConfig().bucket, Key: key }), { expiresIn });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "x";

/** suppliers/<supplier>/<YYYY>/<MM>/<date>_<supplier>_<invoice#|msgid>_<sha8>.<ext> */
export function documentKey(input: {
  supplierName: string;
  date: string; // YYYY-MM-DD
  reference: string;
  sha256: string;
  ext: string;
}): string {
  const [y, m] = input.date.split("-");
  const s = slug(input.supplierName);
  return `suppliers/${s}/${y}/${m}/${input.date}_${s}_${slug(input.reference)}_${input.sha256.slice(0, 8)}.${input.ext}`;
}
