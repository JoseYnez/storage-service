import type { PoolClient, Queryable } from '../db/pool.js';
import { logger } from '../logger.js';
import type { StorageProvider } from '../storage/provider.js';

interface OrphanRow {
  id: string;
  storage_key: string;
}

export interface CollectResult {
  /** Blobs cuyos bytes se borraron del backend. */
  collected: number;
  /** Blobs que resultaron tener archivos vivos: se corrigio el contador. */
  repaired: number;
}

/**
 * Recolecta contenido sin referencias: borra los bytes del backend y marca la
 * fila como 'deleted'.
 *
 * Por que hace falta un periodo de gracia:
 *   reference_count llega a 0 en cuanto se borra el ultimo archivo que usaba
 *   ese contenido. Pero una subida en curso del MISMO contenido puede estar a
 *   punto de reusarlo. El lock de fila resuelve la carrera en el instante
 *   exacto; la gracia evita el caso mas comun y mas caro: borrar bytes que
 *   alguien vuelve a subir un minuto despues.
 *
 * Por que SKIP LOCKED:
 *   varias instancias del servicio pueden correr el recolector a la vez sin
 *   pisarse — cada una toma las filas que ninguna otra tiene.
 *
 * Por que se borra el archivo DENTRO de la transaccion:
 *   mientras la fila este tomada, una subida que quiera deduplicar sobre ella
 *   queda esperando; al commitear ve el borrado y crea una fila nueva, con un
 *   storage_key nuevo (termina en el id). Asi el archivo que borramos no es
 *   nunca el que acaba de escribir otro.
 */
export async function collectOrphanBlobs(
  client: PoolClient,
  storage: StorageProvider,
  batchSize: number,
  graceSec: number,
): Promise<CollectResult> {
  const { rows } = await client.query<OrphanRow>(
    `SELECT id, storage_key
       FROM storage.blobs
      WHERE reference_count = 0
        AND status = 'active'
        AND updated_at < now() - make_interval(secs => $1::double precision)
      ORDER BY updated_at
      FOR UPDATE SKIP LOCKED
      LIMIT $2`,
    [graceSec, batchSize],
  );

  let collected = 0;
  let repaired = 0;

  for (const row of rows) {
    // Recuento defensivo antes de borrar bytes. reference_count lo mantiene el
    // servicio, asi que un bug podria dejarlo en 0 con archivos vivos; la
    // fuente de verdad es storage.files. Un contador roto se arregla, no se
    // convierte en perdida de datos.
    const live = await client.query<{ live: string }>(
      `SELECT count(*)::text AS live
         FROM storage.files
        WHERE blob_id = $1
          AND status <> 'deleted'`,
      [row.id],
    );
    const liveCount = Number(live.rows[0]?.live ?? 0);

    if (liveCount > 0) {
      await client.query(
        `UPDATE storage.blobs SET reference_count = $2 WHERE id = $1`,
        [row.id, liveCount],
      );
      logger.warn(
        { blobId: row.id, liveCount },
        'blob con reference_count desincronizado: contador corregido, no se borro nada',
      );
      repaired++;
      continue;
    }

    try {
      // Primero los bytes, despues la fila. Si el proceso muere en el medio,
      // queda una fila 'active' con reference_count 0 y sin archivo: el ciclo
      // siguiente la vuelve a tomar y el remove() es un no-op.
      await storage.remove(row.storage_key);
      await client.query(
        `UPDATE storage.blobs SET status = 'deleted' WHERE id = $1`,
        [row.id],
      );
      collected++;
    } catch (err) {
      // Este blob se queda para el proximo ciclo; el resto del lote sigue.
      logger.error(
        { err, blobId: row.id, storageKey: row.storage_key },
        'no se pudo recolectar un blob',
      );
    }
  }

  return { collected, repaired };
}

/** Claves por consulta al reconciliar disco contra storage.blobs. */
const ORPHAN_CHECK_BATCH = 500;

/**
 * Reconcilia el BACKEND contra storage.blobs y borra el contenido huerfano:
 * archivos cuya clave no tiene fila vigente (status <> 'deleted').
 *
 * De donde sale un huerfano: el persist() de una subida corre DENTRO de la
 * transaccion, antes del COMMIT. Si despues del rename algo falla (rollback,
 * caida del proceso), los bytes quedan y la fila no. Y como storage_key
 * termina en el id del blob, una re-subida del mismo contenido crea OTRA fila
 * con OTRA ruta: el archivo viejo no se reusa nunca y ningun otro mecanismo
 * lo conoce. Este barrido es la unica via de salida.
 *
 * Salvaguardas contra borrar de mas:
 *   * minAgeSec: un archivo recien escrito puede ser una subida EN CURSO
 *     (persist hecho, COMMIT pendiente). Solo se toca lo mas viejo que este
 *     margen — una transaccion de subida vive segundos, no horas.
 *   * La consulta mira TODAS las filas no borradas, incluidas las de blobs
 *     con reference_count 0: de esos se encarga collectOrphanBlobs con su
 *     propio periodo de gracia, no este barrido.
 *   * Un archivo cuya fila esta status='deleted' es basura por definicion:
 *     el GC borra los bytes ANTES de marcar la fila, asi que si el archivo
 *     sigue ahi es que aquel remove() fallo.
 */
export async function sweepOrphanContent(
  db: Queryable,
  storage: StorageProvider,
  minAgeSec: number,
): Promise<number> {
  const cutoffMs = Date.now() - minAgeSec * 1000;
  let removed = 0;

  let batch: { storageKey: string }[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const keys = batch.map((o) => o.storageKey);
    batch = [];

    const { rows } = await db.query<{ storage_key: string }>(
      `SELECT storage_key
         FROM storage.blobs
        WHERE storage_key = ANY($1::text[])
          AND status <> 'deleted'`,
      [keys],
    );
    const live = new Set(rows.map((r) => r.storage_key));

    for (const key of keys) {
      if (live.has(key)) continue;
      try {
        await storage.remove(key);
        removed++;
        logger.warn({ storageKey: key }, 'contenido huerfano borrado del backend');
      } catch (err) {
        logger.error({ err, storageKey: key }, 'no se pudo borrar un huerfano');
      }
    }
  };

  for await (const object of storage.listContent()) {
    if (object.modifiedAtMs >= cutoffMs) continue;
    batch.push({ storageKey: object.storageKey });
    if (batch.length >= ORPHAN_CHECK_BATCH) await flush();
  }
  await flush();

  return removed;
}
