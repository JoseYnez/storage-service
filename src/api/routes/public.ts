import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../../db/pool.js';
import { getContentRef } from '../../domain/files.js';
import { storageProvider } from '../../storage/local.js';
import { sendZodError } from '../errors.js';
import {
  idParamSchema,
  signedDownloadQuerySchema,
  wantsAttachment,
} from '../schemas.js';
import { sendContent } from '../send-content.js';
import { verifySignedLink } from '../signed-url.js';

/**
 * Descarga por ENLACE FIRMADO — la unica ruta de contenido sin API key.
 *
 * Vive bajo /v1/public/ y no junto a las demas de /v1/files para que el limite
 * sea visible en la URL y en el hook de auth de server.ts: lo que cuelga de
 * /v1/public/ esta fuera de la api-key a proposito, y se ve de un vistazo.
 *
 * La autorizacion es la firma, que ata la URL a UN id de archivo y a un
 * vencimiento. No se filtra por cliente: quien tiene una firma valida para ese
 * id ya puede leerlo, y este servicio no sabe (ni necesita saber) quien es.
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/public/files/:id/content',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) return sendZodError(reply, params.error);
      const query = signedDownloadQuerySchema.safeParse(req.query);
      if (!query.success) return sendZodError(reply, query.error);

      // Primero la firma, despues la base: una peticion sin firma valida no
      // llega a hacer ninguna consulta.
      verifySignedLink(params.data.id, query.data.expires, query.data.sig);

      const ref = await getContentRef(pool, params.data.id, null);

      return sendContent(
        req,
        reply,
        storageProvider,
        ref,
        wantsAttachment(query.data.download),
      );
    },
  );
}
