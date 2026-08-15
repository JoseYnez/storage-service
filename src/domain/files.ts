import type { PoolClient, Queryable } from '../db/pool.js';
import type { FileContentRef, FileMetadata, StorageBackend } from '../types.js';
import { FileNotFound } from './errors.js';
import { releaseBlob } from './upload.js';

interface FileRow {
  id: string;
  bucket_code: string;
  path: string;
  filename: string;
  content_type: string;
  size_bytes: string; // BIGINT llega como string
  sha256: string;
  metadata: unknown | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  f.id, b.code::text AS bucket_code, f.path, f.filename, f.content_type,
  f.size_bytes, f.sha256, f.metadata, f.created_at, f.updated_at`;

const FROM_JOIN = `
  FROM storage.files f
  JOIN storage.buckets b
    ON b.id = f.bucket_id
   AND b.customer_id = f.customer_id`;

/** Metadata de un archivo por id, acotado al cliente de la API key. */
export async function getFileById(
  db: Queryable,
  customerId: string,
  id: string,
): Promise<FileMetadata> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${SELECT_COLUMNS}
     ${FROM_JOIN}
      WHERE f.id = $1
        AND f.customer_id = $2
        AND f.status <> 'deleted'`,
    [id, customerId],
  );
  const row = rows[0];
  if (!row) throw FileNotFound();
  return mapRow(row);
}

/**
 * Metadata por la ruta con la que la app lo guardo — sirve para volver a pedir
 * un archivo sin haber guardado el id. Solo filas vigentes.
 */
export async function getFileByPath(
  db: Queryable,
  customerId: string,
  bucketId: string,
  path: string,
): Promise<FileMetadata> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${SELECT_COLUMNS}
     ${FROM_JOIN}
      WHERE f.bucket_id = $1
        AND f.path = $2
        AND f.customer_id = $3
        AND f.status <> 'deleted'`,
    [bucketId, path, customerId],
  );
  const row = rows[0];
  if (!row) throw FileNotFound();
  return mapRow(row);
}

export interface ListFilesInput {
  customerId: string;
  bucketId: string;
  /** Prefijo de ruta ("2026/08/"). null = todo el bucket. */
  prefix: string | null;
  limit: number;
  /** Ultima ruta de la pagina anterior; se devuelve todo lo que siga. */
  cursor: string | null;
}

export interface ListFilesResult {
  files: FileMetadata[];
  /** Valor de `cursor` para pedir la pagina siguiente; null si no hay mas. */
  nextCursor: string | null;
}

/**
 * Listado por prefijo, paginado por CURSOR sobre la ruta (keyset), no por
 * OFFSET: un OFFSET grande obliga a la base a recorrer y descartar todo lo
 * anterior, y ademas se descoloca si alguien sube o borra entre dos paginas.
 * Con cursor, cada pagina es un rango del indice uq_files_bucket_id_path.
 *
 * El prefijo se pasa como parametro y se compara con LIKE sobre un patron
 * armado con literales escapados: nunca se concatena texto del cliente al SQL.
 */
export async function listFiles(
  db: Queryable,
  input: ListFilesInput,
): Promise<ListFilesResult> {
  // Se pide uno de mas para saber si hay pagina siguiente sin contar el total.
  const { rows } = await db.query<FileRow>(
    `SELECT ${SELECT_COLUMNS}
     ${FROM_JOIN}
      WHERE f.bucket_id = $1
        AND f.customer_id = $2
        AND f.status <> 'deleted'
        AND ($3::text IS NULL OR f.path > $3)
        AND ($4::text IS NULL OR f.path LIKE $4)
      ORDER BY f.path
      LIMIT $5`,
    [
      input.bucketId,
      input.customerId,
      input.cursor,
      input.prefix === null ? null : `${escapeLike(input.prefix)}%`,
      input.limit + 1,
    ],
  );

  const page = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;
  return {
    files: page.map(mapRow),
    nextCursor: hasMore ? (page[page.length - 1]?.path ?? null) : null,
  };
}

interface ContentRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  backend: StorageBackend;
  storage_key: string;
}

/**
 * Todo lo necesario para servir el contenido: metadata de cabeceras + donde
 * estan los bytes.
 *
 * customerId null = la autorizacion ya la dio la firma del enlace, que ata la
 * URL a ESTE id concreto. Filtrar ademas por cliente no agregaria nada: quien
 * tiene una firma valida para el id ya puede leerlo.
 */
export async function getContentRef(
  db: Queryable,
  id: string,
  customerId: string | null,
): Promise<FileContentRef> {
  const { rows } = await db.query<ContentRow>(
    `SELECT f.id, f.filename, f.content_type, f.size_bytes, f.sha256,
            bl.backend, bl.storage_key
       FROM storage.files f
       JOIN storage.blobs bl
         ON bl.id = f.blob_id
        AND bl.customer_id = f.customer_id
      WHERE f.id = $1
        AND ($2::uuid IS NULL OR f.customer_id = $2)
        AND f.status <> 'deleted'`,
    [id, customerId],
  );
  const row = rows[0];
  if (!row) throw FileNotFound();
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    backend: row.backend,
    storageKey: row.storage_key,
  };
}

/**
 * Borrado logico: marca el archivo como 'deleted' y suelta su referencia al
 * blob. El contenido NO se borra aca — si nadie mas lo usa, el recolector se
 * lo lleva pasado el periodo de gracia. Debe correr dentro de
 * withAuditContext para que el trigger popule deleted_by.
 */
export async function softDeleteFile(
  client: PoolClient,
  customerId: string,
  id: string,
): Promise<void> {
  const { rows } = await client.query<{ blob_id: string }>(
    `UPDATE storage.files
        SET status = 'deleted'
      WHERE id = $1
        AND customer_id = $2
        AND status <> 'deleted'
      RETURNING blob_id`,
    [id, customerId],
  );
  const row = rows[0];
  // Borrar dos veces no es un error de negocio distinto de borrar algo que no
  // existe: las dos cosas son 404.
  if (!row) throw FileNotFound();
  await releaseBlob(client, row.blob_id);
}

/** Escapa los comodines de LIKE para que un prefijo sea texto literal. */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function mapRow(row: FileRow): FileMetadata {
  return {
    id: row.id,
    bucketCode: row.bucket_code,
    path: row.path,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
