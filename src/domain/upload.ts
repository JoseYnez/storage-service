import { config } from '../config/index.js';
import type { PoolClient } from '../db/pool.js';
import { logger } from '../logger.js';
import type { StorageProvider } from '../storage/provider.js';
import type { ResolvedBucket, StagedContent } from '../types.js';
import { assertUploadAllowed, resolveBucket } from './buckets.js';

export interface CommitUploadInput {
  customerId: string;
  appId: string;
  /** Bucket por code; null = resolver por defaults (app, luego cliente). */
  bucketCode: string | null;
  /** Ruta logica ya normalizada. */
  path: string;
  filename: string;
  contentType: string;
  metadata: unknown | null;
  /** Contenido ya escrito en el area temporal, con su sha256 calculado. */
  staged: StagedContent;
}

export interface CommitUploadResult {
  id: string;
  bucketCode: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  /** true si el contenido ya estaba almacenado y se reuso el blob. */
  deduplicated: boolean;
  /** true si la ruta ya estaba ocupada y el archivo anterior fue reemplazado. */
  replaced: boolean;
}

interface BlobClaim {
  id: string;
  storageKey: string;
  /** true si la fila se creo en esta transaccion (contenido nuevo). */
  created: boolean;
}

/**
 * Cierra una subida: resuelve bucket, valida limites, deduplica el contenido,
 * reemplaza lo que hubiera en esa ruta e inserta el archivo logico.
 *
 * Debe correr dentro de withAuditContext (recibe el client de esa transaccion)
 * para que el trigger de campos de control popule created_by.
 *
 * ORDEN DE LAS OPERACIONES — importa:
 *   1. Bucket y limites primero: rechazar una subida no debe haber tocado nada.
 *   2. La fila del blob ANTES que el disco. Reclamar la fila es lo que le gana
 *      la carrera al recolector: si el GC esta por llevarse ese contenido, o
 *      nos bloquea a nosotros (y despues vemos su borrado) o lo bloqueamos a el
 *      (y ve reference_count > 0 y lo suelta). Escribir el archivo antes de
 *      reclamar la fila seria escribir en una ruta que el GC puede borrar un
 *      instante despues.
 *   3. El disco antes del COMMIT: si el rename falla, la transaccion no se
 *      commitea y no queda una fila prometiendo bytes que no existen.
 */
export async function commitUpload(
  client: PoolClient,
  storage: StorageProvider,
  input: CommitUploadInput,
): Promise<CommitUploadResult> {
  const bucket = await resolveBucket(
    client,
    input.customerId,
    input.appId,
    input.bucketCode,
  );

  // Serializa las subidas concurrentes a la MISMA ruta. Sin esto, dos subidas
  // simultaneas pasan las dos por releasePathIfTaken sin ver la fila de la
  // otra (READ COMMITTED) y la segunda muere con unique violation sobre
  // uq_files_bucket_id_path. El lock es transaction-scoped (se libera solo en
  // COMMIT/ROLLBACK) y solo choca entre subidas a la misma (bucket, ruta):
  // resultado, last-writer-wins limpio en vez de un 409 aleatorio.
  await client.query(
    `SELECT pg_advisory_xact_lock(
              hashtextextended('storage.files.path:' || $1::text || '/' || $2, 0)
            )`,
    [bucket.id, input.path],
  );

  await assertUploadAllowed(
    client,
    bucket,
    input.contentType,
    input.staged.sizeBytes,
    config.MAX_UPLOAD_BYTES,
  );

  const blob = await claimBlob(client, input.customerId, input.staged);

  if (blob.created) {
    await storage.persist(input.staged, blob.storageKey);
  } else if (!(await storage.exists(blob.storageKey))) {
    // La fila existia pero el contenido no esta en el backend: pudo morir el
    // proceso entre el rename y el COMMIT de la subida que creo el blob. Como
    // tenemos exactamente esos bytes en la mano, se sana en vez de fallar.
    logger.warn(
      { blobId: blob.id, storageKey: blob.storageKey },
      'blob sin contenido en el backend: se restaura con el contenido de esta subida',
    );
    await storage.persist(input.staged, blob.storageKey);
  } else {
    await storage.discard(input.staged);
  }

  const replaced = await releasePathIfTaken(client, bucket.id, input.path);

  const { rows } = await client.query<{ id: string; created_at: string }>(
    `INSERT INTO storage.files (
        bucket_id, customer_id, blob_id, app_id,
        path, filename, content_type,
        size_bytes, sha256, metadata
     ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10::jsonb
     )
     RETURNING id, created_at`,
    [
      bucket.id,
      input.customerId,
      blob.id,
      input.appId,
      input.path,
      input.filename,
      input.contentType,
      input.staged.sizeBytes,
      input.staged.sha256,
      input.metadata === null ? null : JSON.stringify(input.metadata),
    ],
  );

  const row = rows[0];
  // El INSERT no lleva ON CONFLICT: si esta fila no volvio, es un bug de
  // wiring, no un caso de negocio.
  if (!row) throw new Error('el INSERT de storage.files no devolvio fila');

  return {
    id: row.id,
    bucketCode: bucket.code,
    path: input.path,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.staged.sizeBytes,
    sha256: input.staged.sha256,
    createdAt: row.created_at,
    deduplicated: !blob.created,
    replaced,
  };
}

/**
 * Reclama la fila del blob para este contenido: la crea si es contenido nuevo,
 * o suma una referencia a la que ya existia.
 *
 * La carrera contra el recolector se resuelve sola, sin locks explicitos:
 *   * INSERT ... ON CONFLICT DO NOTHING espera a que la transaccion en
 *     conflicto termine, asi que si el GC tiene la fila tomada, esperamos.
 *   * Si el GC la borro (status = 'deleted'), el UPDATE guardado por
 *     status <> 'deleted' no toca nada y volvemos al INSERT, que ahora si
 *     entra porque el indice unico parcial ya no la ve.
 * Dos vueltas alcanzan: despues del borrado del GC no hay una tercera fila
 * posible para el mismo (customer_id, sha256).
 */
async function claimBlob(
  client: PoolClient,
  customerId: string,
  staged: StagedContent,
): Promise<BlobClaim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // reference_count arranca en 1: el archivo que la justifica se inserta en
    // esta misma transaccion.
    const inserted = await client.query<{ id: string; storage_key: string }>(
      `INSERT INTO storage.blobs (customer_id, sha256, size_bytes, backend, reference_count)
            VALUES ($1, $2, $3, 'local', 1)
       ON CONFLICT (customer_id, sha256)
          WHERE status <> 'deleted'
          DO NOTHING
         RETURNING id, storage_key`,
      [customerId, staged.sha256, staged.sizeBytes],
    );
    const created = inserted.rows[0];
    if (created) {
      return { id: created.id, storageKey: created.storage_key, created: true };
    }

    // Ya existia: sumamos la referencia. El UPDATE toma el lock de la fila, que
    // es lo que frena al GC.
    const updated = await client.query<{ id: string; storage_key: string }>(
      `UPDATE storage.blobs
          SET reference_count = reference_count + 1
        WHERE customer_id = $1
          AND sha256 = $2
          AND status <> 'deleted'
        RETURNING id, storage_key`,
      [customerId, staged.sha256],
    );
    const existing = updated.rows[0];
    if (existing) {
      return { id: existing.id, storageKey: existing.storage_key, created: false };
    }
    // Cero filas: el GC la borro entre el INSERT y el UPDATE. Otra vuelta.
  }

  throw new Error(
    'no se pudo reclamar el blob tras dos intentos: contencion inesperada con el recolector',
  );
}

/**
 * Libera la ruta si ya estaba ocupada: marca el archivo anterior como borrado
 * (lo que libera uq_files_bucket_id_path) y le suelta la referencia a su blob.
 * Devuelve true si hubo un reemplazo.
 *
 * Si el archivo anterior apuntaba AL MISMO blob que el nuevo, el +1 de
 * claimBlob y el -1 de aca se cancelan: subir dos veces el mismo contenido a la
 * misma ruta deja el contador donde estaba, que es lo correcto.
 */
async function releasePathIfTaken(
  client: PoolClient,
  bucketId: string,
  path: string,
): Promise<boolean> {
  const { rows } = await client.query<{ blob_id: string }>(
    `UPDATE storage.files
        SET status = 'deleted'
      WHERE bucket_id = $1
        AND path = $2
        AND status <> 'deleted'
      RETURNING blob_id`,
    [bucketId, path],
  );

  // uq_files_bucket_id_path garantiza como maximo una, pero el bucle no cuesta
  // nada y no depende de esa garantia.
  for (const row of rows) {
    await releaseBlob(client, row.blob_id);
  }
  return rows.length > 0;
}

/**
 * Suelta una referencia de un blob. GREATEST(..., 0) es una red: el CHECK de la
 * tabla ya impide negativos, y llegar a cero de mas significaria que el
 * contador se desincronizo — preferimos que el recolector lo levante como
 * huerfano (recontable contra storage.files) antes que abortar la transaccion
 * del usuario por un error de contabilidad interno.
 */
export async function releaseBlob(client: PoolClient, blobId: string): Promise<void> {
  await client.query(
    `UPDATE storage.blobs
        SET reference_count = GREATEST(reference_count - 1, 0)
      WHERE id = $1`,
    [blobId],
  );
}
