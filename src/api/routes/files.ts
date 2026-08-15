import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePermission, STORAGE_PERMISSIONS } from '../../auth/authorize.js';
import { config } from '../../config/index.js';
import { withAuditContext } from '../../db/audit-context.js';
import { pool } from '../../db/pool.js';
import { resolveBucket } from '../../domain/buckets.js';
import { FileTooLarge, PathConflict } from '../../domain/errors.js';
import {
  getContentRef,
  getFileById,
  getFileByPath,
  listFiles,
  softDeleteFile,
} from '../../domain/files.js';
import {
  normalizeContentType,
  normalizeFilename,
  normalizePath,
} from '../../domain/normalize.js';
import { commitUpload, type CommitUploadResult } from '../../domain/upload.js';
import { storageProvider } from '../../storage/local.js';
import { ContentTooLargeError } from '../../storage/provider.js';
import type { FileMetadata, StagedContent } from '../../types.js';
import { sendZodError } from '../errors.js';
import { actorOf, principalOf } from '../principal.js';
import {
  downloadQuerySchema,
  idParamSchema,
  linkBodySchema,
  listFilesQuerySchema,
  uploadJsonBodySchema,
  uploadMultipartFieldsSchema,
  wantsAttachment,
} from '../schemas.js';
import { sendContent } from '../send-content.js';
import { issueSignedLink } from '../signed-url.js';

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // POST /v1/files — subir
  // ---------------------------------------------------------------------------
  // Una sola ruta para las dos formas de subir, discriminadas por Content-Type:
  //   multipart/form-data -> el archivo se escribe a disco en streaming
  //   application/json    -> el contenido viaja en base64 dentro del body
  // Son la misma operacion con distinta envoltura; separarlas en dos rutas
  // obligaria a los clientes a elegir una URL segun el tamaño del archivo.
  app.post('/v1/files', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = principalOf(req);
    await requirePermission(req, STORAGE_PERMISSIONS.write);
    const { customerId, appId } = principal;

    // El temporal se registra apenas existe: pase lo que pase mas abajo, el
    // finally sabe que hay algo que limpiar.
    let staged: StagedContent | null = null;
    let committed = false;
    // Ruta ya normalizada, visible para el catch (mensaje del 409).
    let uploadPath: string | null = null;

    try {
      let content: StagedContent;
      let bucketCode: string | null;
      let rawPath: string | null;
      let rawFilename: string | null;
      let declaredType: string | null;
      let metadata: unknown | null;

      if (req.isMultipart()) {
        const parsed = await readMultipart(req, (s) => {
          staged = s;
        });
        if (!parsed.staged) {
          return reply.code(400).send({
            error: 'validation_error',
            message: 'La peticion multipart no trae ninguna parte de archivo.',
          });
        }
        if (parsed.truncated) throw FileTooLarge(config.MAX_UPLOAD_BYTES);

        const fields = uploadMultipartFieldsSchema.safeParse(parsed.fields);
        if (!fields.success) return sendZodError(reply, fields.error);

        content = parsed.staged;
        bucketCode = fields.data.bucket_code ?? null;
        rawPath = fields.data.path ?? null;
        // El nombre del campo del form gana sobre el del archivo subido: es lo
        // que el cliente eligio a proposito.
        rawFilename = fields.data.filename ?? parsed.filename;
        declaredType = fields.data.content_type ?? parsed.mimetype;
        metadata = fields.data.metadata ?? null;
      } else {
        const body = uploadJsonBodySchema.safeParse(req.body);
        if (!body.success) return sendZodError(reply, body.error);

        content = await storageProvider.stageBuffer(
          Buffer.from(body.data.content_base64, 'base64'),
          config.MAX_UPLOAD_BYTES,
        );
        staged = content;

        bucketCode = body.data.bucket_code ?? null;
        rawPath = body.data.path ?? null;
        rawFilename = body.data.filename;
        declaredType = body.data.content_type ?? null;
        metadata = body.data.metadata ?? null;
      }

      const filename = normalizeFilename(rawFilename);
      uploadPath = normalizePath(rawPath, filename);
      const path = uploadPath;

      const result = await withAuditContext(
        { action: 'POST /v1/files', ...actorOf(principal) },
        (client) =>
          commitUpload(client, storageProvider, {
            customerId,
            appId,
            bucketCode,
            path,
            filename,
            contentType: normalizeContentType(declaredType, filename),
            metadata,
            staged: content,
          }),
      );

      // commitUpload ya movio o descarto el temporal.
      committed = true;
      return reply.code(201).send(toUploadResponse(result));
    } catch (err) {
      // El limite se detecta en el borde del stream, donde todavia no hay
      // dominio; aca se traduce al error de dominio que la API sabe mapear.
      if (err instanceof ContentTooLargeError) throw FileTooLarge(err.maxBytes);
      // Carrera de dos subidas a la misma ruta: el lock advisory de
      // commitUpload la serializa, pero si igual llegara la unique violation
      // (p. ej. lock timeout ajeno), es un conflicto del cliente, no un 500.
      if (isUniquePathViolation(err)) throw PathConflict(uploadPath ?? 'solicitada');
      throw err;
    } finally {
      if (staged && !committed) await storageProvider.discard(staged);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /v1/files — listado por prefijo, o archivo exacto por ruta
  // ---------------------------------------------------------------------------
  app.get('/v1/files', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listFilesQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendZodError(reply, parsed.error);

    await requirePermission(req, STORAGE_PERMISSIONS.read);
    const { customerId, appId } = principalOf(req);
    const query = parsed.data;

    const bucket = await resolveBucket(
      pool,
      customerId,
      appId,
      query.bucket_code ?? null,
    );

    // Con path se pide UN archivo; sin path, la pagina del listado.
    if (query.path) {
      const file = await getFileByPath(pool, customerId, bucket.id, query.path);
      return reply.send(toFileResponse(file));
    }

    const result = await listFiles(pool, {
      customerId,
      bucketId: bucket.id,
      prefix: query.prefix ?? null,
      limit: query.limit,
      cursor: query.cursor ?? null,
    });

    return reply.send({
      bucket_code: bucket.code,
      files: result.files.map(toFileResponse),
      next_cursor: result.nextCursor,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/files/:id — metadata
  // ---------------------------------------------------------------------------
  app.get('/v1/files/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) return sendZodError(reply, parsed.error);

    await requirePermission(req, STORAGE_PERMISSIONS.read);
    const { customerId, appId } = principalOf(req);
    const file = await getFileById(pool, customerId, appId, parsed.data.id);
    return reply.send(toFileResponse(file));
  });

  // ---------------------------------------------------------------------------
  // GET /v1/files/:id/content — descarga con API key
  // ---------------------------------------------------------------------------
  app.get('/v1/files/:id/content', async (req: FastifyRequest, reply: FastifyReply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return sendZodError(reply, params.error);
    const query = downloadQuerySchema.safeParse(req.query);
    if (!query.success) return sendZodError(reply, query.error);

    await requirePermission(req, STORAGE_PERMISSIONS.read);
    const { customerId, appId } = principalOf(req);
    const ref = await getContentRef(pool, params.data.id, customerId, appId);

    return sendContent(
      req,
      reply,
      storageProvider,
      ref,
      wantsAttachment(query.data.download),
    );
  });

  // ---------------------------------------------------------------------------
  // POST /v1/files/:id/link — URL firmada, para pasarle a un navegador
  // ---------------------------------------------------------------------------
  app.post('/v1/files/:id/link', async (req: FastifyRequest, reply: FastifyReply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return sendZodError(reply, params.error);
    const body = linkBodySchema.safeParse(req.body ?? {});
    if (!body.success) return sendZodError(reply, body.error);

    // Emitir un enlace es delegar la lectura a un portador anonimo: permiso
    // propio, separado de read.
    await requirePermission(req, STORAGE_PERMISSIONS.share);
    const { customerId, appId } = principalOf(req);
    // Se comprueba que el archivo exista Y sea de este cliente y de un bucket
    // accesible a esta app ANTES de firmar: la firma no valida nada por si
    // sola, solo prueba que este servicio la emitio. Emitirla para un id ajeno
    // seria regalar acceso.
    const file = await getFileById(pool, customerId, appId, params.data.id);

    const link = issueSignedLink(
      file.id,
      body.data.expires_in_sec ?? config.DOWNLOAD_URL_TTL_SEC,
    );

    return reply.send({
      url: link.url,
      expires_at: link.expiresAt,
      expires_in_sec: link.expiresInSec,
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /v1/files/:id — borrado logico
  // ---------------------------------------------------------------------------
  app.delete('/v1/files/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) return sendZodError(reply, parsed.error);

    const principal = principalOf(req);
    await requirePermission(req, STORAGE_PERMISSIONS.delete);
    await withAuditContext(
      { action: 'DELETE /v1/files/:id', ...actorOf(principal) },
      (client) =>
        softDeleteFile(client, principal.customerId, principal.appId, parsed.data.id),
    );

    // 204: el contenido se lo lleva el recolector despues, no hay nada que
    // contarle al cliente.
    return reply.code(204).send();
  });
}

/**
 * Unique violation sobre uq_files_bucket_id_path: dos subidas concurrentes a
 * la misma ruta. Se identifica por codigo SQLSTATE + constraint para no
 * confundirla con otra unique (p. ej. la de dedup de blobs).
 */
function isUniquePathViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgErr = err as { code?: unknown; constraint?: unknown };
  return pgErr.code === '23505' && pgErr.constraint === 'uq_files_bucket_id_path';
}

interface MultipartRead {
  fields: Record<string, string>;
  staged: StagedContent | null;
  filename: string | null;
  mimetype: string | null;
  /** true si @fastify/multipart corto el archivo por superar el limite. */
  truncated: boolean;
}

/**
 * Consume la peticion multipart: escribe la parte de archivo a disco en
 * streaming y junta los campos de texto.
 *
 * Los campos se recogen vengan ANTES o DESPUES del archivo. Por eso el
 * contenido se escribe al area temporal sin haber validado todavia el bucket:
 * hasta terminar de leer la peticion no se sabe a que bucket iba. Se paga un
 * archivo temporal que a veces se descarta, a cambio de no depender del orden
 * de las partes, que el cliente no siempre controla.
 *
 * `onStaged` registra el temporal en el llamador apenas existe, para que su
 * finally pueda limpiarlo aunque lo que falle sea la validacion de un campo
 * posterior.
 */
async function readMultipart(
  req: FastifyRequest,
  onStaged: (staged: StagedContent) => void,
): Promise<MultipartRead> {
  const fields: Record<string, string> = {};
  let staged: StagedContent | null = null;
  let filename: string | null = null;
  let mimetype: string | null = null;
  let truncated = false;

  for await (const part of req.parts()) {
    if (part.type !== 'file') {
      fields[part.fieldname] = String(part.value);
      continue;
    }

    const filePart = part as MultipartFile;

    // Solo la primera parte de archivo. Las demas se drenan: si no se consume
    // el stream, la peticion queda colgada.
    if (staged) {
      filePart.file.resume();
      continue;
    }

    filename = filePart.filename || null;
    mimetype = filePart.mimetype || null;
    staged = await storageProvider.stage(filePart.file, config.MAX_UPLOAD_BYTES);
    onStaged(staged);
    // El limite del plugin corta el stream sin lanzar: sin este chequeo se
    // guardaria un archivo truncado como si estuviera completo.
    truncated = filePart.file.truncated;
  }

  return { fields, staged, filename, mimetype, truncated };
}

function toUploadResponse(result: CommitUploadResult) {
  return {
    id: result.id,
    bucket_code: result.bucketCode,
    path: result.path,
    filename: result.filename,
    content_type: result.contentType,
    size_bytes: result.sizeBytes,
    sha256: result.sha256,
    created_at: result.createdAt,
    deduplicated: result.deduplicated,
    replaced: result.replaced,
  };
}

function toFileResponse(file: FileMetadata) {
  return {
    id: file.id,
    bucket_code: file.bucketCode,
    path: file.path,
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    sha256: file.sha256,
    metadata: file.metadata,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
  };
}
