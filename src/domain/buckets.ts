import type { PoolClient, Queryable } from '../db/pool.js';
import type { ResolvedBucket } from '../types.js';
import {
  BucketNotFound,
  BucketNotResolved,
  FileTooLarge,
  MimeNotAllowed,
  QuotaExceeded,
} from './errors.js';

interface BucketRow {
  id: string;
  code: string;
  quota_bytes: string | null; // BIGINT llega como string en node-postgres
  max_file_size_bytes: string | null;
  allowed_mime_types: string[] | null;
}

const SELECT_COLUMNS = `
  id, code::text AS code, quota_bytes, max_file_size_bytes, allowed_mime_types`;

/**
 * Resuelve el bucket donde guardar, en el ORDEN CANONICO del header de
 * 05_storage_bucket_apps.sql:
 *
 *   1. La subida nombra el bucket por code       -> ese
 *   2. Vinculo default de la app (bucket_apps)   -> ese
 *   3. Fallback del cliente (buckets.is_default) -> ese
 *   4. Nada                                      -> error, no se adivina
 *
 * Resolver es elegir DONDE, no obtener permiso para todo: los limites del
 * bucket elegido se verifican igual (ver assertUploadAllowed).
 */
export async function resolveBucket(
  client: Queryable,
  customerId: string,
  appId: string,
  bucketCode: string | null,
): Promise<ResolvedBucket> {
  // 1. Por code explicito.
  if (bucketCode) {
    const { rows } = await client.query<BucketRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM storage.buckets
        WHERE customer_id = $1
          AND code = $2
          AND status = 'active'`,
      [customerId, bucketCode],
    );
    const row = rows[0];
    if (!row) throw BucketNotFound(bucketCode);
    return toResolved(row);
  }

  // 2. Default de la app en el vinculo M:N. La FK compuesta garantiza que el
  //    bucket pertenece al mismo cliente; igual filtramos por los dos.
  const appDefault = await client.query<BucketRow>(
    `SELECT ${prefixed('b')}
       FROM storage.bucket_apps ba
       JOIN storage.buckets b
         ON b.id = ba.bucket_id
        AND b.customer_id = ba.customer_id
      WHERE ba.customer_id = $1
        AND ba.app_id = $2
        AND ba.is_default
        AND ba.status = 'active'
        AND b.status = 'active'
      LIMIT 1`,
    [customerId, appId],
  );
  if (appDefault.rows[0]) return toResolved(appDefault.rows[0]);

  // 3. Fallback del cliente.
  const customerDefault = await client.query<BucketRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM storage.buckets
      WHERE customer_id = $1
        AND is_default
        AND status = 'active'
      LIMIT 1`,
    [customerId],
  );
  if (customerDefault.rows[0]) return toResolved(customerDefault.rows[0]);

  // 4. No se adivina.
  throw BucketNotResolved();
}

/** Lista los buckets vigentes del cliente — el GET /v1/buckets de la API. */
export async function listBuckets(
  db: Queryable,
  customerId: string,
): Promise<(ResolvedBucket & { name: string; isDefault: boolean })[]> {
  const { rows } = await db.query<BucketRow & { name: string; is_default: boolean }>(
    `SELECT ${SELECT_COLUMNS}, name, is_default
       FROM storage.buckets
      WHERE customer_id = $1
        AND status = 'active'
      ORDER BY code`,
    [customerId],
  );
  return rows.map((row) => ({
    ...toResolved(row),
    name: row.name,
    isDefault: row.is_default,
  }));
}

/**
 * Verifica los limites del bucket para un contenido concreto. Corre DENTRO de
 * la transaccion de subida, con el contenido ya en el area temporal: es la
 * unica forma de conocer el tamaño real de un stream (el Content-Length de una
 * peticion multipart no es de fiar) y el unico momento en que el sha256 ya
 * existe.
 *
 * Cuota: se suma el tamaño de los archivos vigentes del bucket. Se cuentan
 * BYTES LOGICOS, no ocupacion real en disco — dos archivos con el mismo
 * contenido consumen cuota dos veces aunque en disco ocupen una. La cuota mide
 * lo que el cliente guardo, no lo que la deduplicacion le ahorro a la
 * plataforma.
 */
export async function assertUploadAllowed(
  client: PoolClient,
  bucket: ResolvedBucket,
  contentType: string,
  sizeBytes: number,
  globalMaxBytes: number,
): Promise<void> {
  // 1. Tamaño: manda el menor entre el techo del servicio y el del bucket.
  const maxBytes = Math.min(bucket.maxFileSizeBytes ?? Infinity, globalMaxBytes);
  if (sizeBytes > maxBytes) throw FileTooLarge(maxBytes);

  // 2. Lista blanca de MIME. null = sin restriccion (un array vacio no puede
  //    existir: lo prohibe ck_buckets_allowed_mime_types).
  if (bucket.allowedMimeTypes && !bucket.allowedMimeTypes.includes(contentType)) {
    throw MimeNotAllowed(contentType, bucket.code);
  }

  // 3. Cuota. Solo si el bucket tiene una: sin cuota no hay nada que sumar.
  if (bucket.quotaBytes !== null) {
    const { rows } = await client.query<{ used: string }>(
      `SELECT COALESCE(sum(size_bytes), 0)::text AS used
         FROM storage.files
        WHERE bucket_id = $1
          AND status <> 'deleted'`,
      [bucket.id],
    );
    const used = Number(rows[0]?.used ?? 0);
    if (used + sizeBytes > bucket.quotaBytes) throw QuotaExceeded(bucket.code);
  }
}

function prefixed(alias: string): string {
  return `${alias}.id, ${alias}.code::text AS code, ${alias}.quota_bytes,
          ${alias}.max_file_size_bytes, ${alias}.allowed_mime_types`;
}

function toResolved(row: BucketRow): ResolvedBucket {
  return {
    id: row.id,
    code: row.code,
    // BIGINT viaja como string para no perder precision por encima de 2^53.
    // Un limite de almacenamiento real nunca llega ahi, asi que Number alcanza
    // y evita propagar BigInt por toda la comparacion.
    quotaBytes: row.quota_bytes === null ? null : Number(row.quota_bytes),
    maxFileSizeBytes:
      row.max_file_size_bytes === null ? null : Number(row.max_file_size_bytes),
    allowedMimeTypes: row.allowed_mime_types,
  };
}
