import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePermission, STORAGE_PERMISSIONS } from '../../auth/authorize.js';
import { pool } from '../../db/pool.js';
import { listBuckets } from '../../domain/buckets.js';
import { principalOf } from '../principal.js';

/**
 * Solo lectura. El ALTA de buckets no pasa por la API: es configuracion, y la
 * hace scripts/register-bucket.mjs (o, en un despliegue real, el servicio de
 * administracion). Este endpoint existe para que una app pueda descubrir en
 * que buckets puede escribir y con que limites, sin tenerlos hardcodeados.
 */
export async function bucketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/buckets', async (req: FastifyRequest, reply: FastifyReply) => {
    await requirePermission(req, STORAGE_PERMISSIONS.read);
    const { customerId, appId } = principalOf(req);
    const buckets = await listBuckets(pool, customerId, appId);

    return reply.send({
      buckets: buckets.map((bucket) => ({
        code: bucket.code,
        name: bucket.name,
        is_default: bucket.isDefault,
        quota_bytes: bucket.quotaBytes,
        max_file_size_bytes: bucket.maxFileSizeBytes,
        allowed_mime_types: bucket.allowedMimeTypes,
      })),
    });
  });
}
