import multipart from '@fastify/multipart';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { resolvePrincipal } from '../auth/api-key.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { Principal } from '../types.js';
import { toHttpError } from './errors.js';
import { bucketRoutes } from './routes/buckets.js';
import { fileRoutes } from './routes/files.js';
import { publicRoutes } from './routes/public.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Rutas que no exigen api-key. */
const PUBLIC_PATHS = new Set(['/health', '/health/live', '/health/ready']);

/**
 * Las descargas por enlace firmado tampoco llevan api-key: la firma es la
 * autorizacion. Es un PREFIJO y no un path exacto porque lleva el id adentro.
 */
const PUBLIC_PREFIX = '/v1/public/';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    // Cast al tipo base: pasar la instancia concreta de pino haria que Fastify
    // infiera un logger custom y el tipo de retorno FastifyInstance no cerraria.
    loggerInstance: logger as FastifyBaseLogger,
    // Techo del body JSON. base64 infla 4/3, mas el resto de los campos: si
    // fuera igual a MAX_UPLOAD_BYTES, un archivo del tamaño maximo se
    // rechazaria por body y no por su propio limite, con el error equivocado.
    // La ruta multipart no pasa por aca: se corta en el stream.
    bodyLimit: Math.ceil(config.MAX_UPLOAD_BYTES * (4 / 3)) + 64 * 1024,
  });

  app.register(multipart, {
    limits: {
      // El limite real lo aplica el provider mientras escribe; este es el corte
      // del parser, que ademas evita que un cliente mantenga abierta una subida
      // infinita.
      fileSize: config.MAX_UPLOAD_BYTES,
      // Un archivo por peticion: subir varios de una es otra operacion, con
      // otro contrato de respuesta.
      files: 1,
    },
  });

  // Auth por api-key para todo lo que no sea health ni descarga firmada.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(path) || path.startsWith(PUBLIC_PREFIX)) return;

    const key = req.headers['x-api-key'];
    const principal = resolvePrincipal(Array.isArray(key) ? key[0] : key);
    if (!principal) {
      return reply
        .code(401)
        .send({ error: 'unauthorized', message: 'API key ausente o invalida.' });
    }
    req.principal = principal;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    // Errores de validacion de Fastify o de dominio -> HTTP; el resto se loguea.
    const statusCode =
      typeof err === 'object' && err !== null && 'statusCode' in err
        ? Number((err as { statusCode?: number }).statusCode)
        : undefined;
    if (statusCode === undefined || Number.isNaN(statusCode) || statusCode >= 500) {
      req.log.error({ err }, 'error no controlado en la peticion');
    }
    return toHttpError(reply, err);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(fileRoutes);
  app.register(bucketRoutes);
  app.register(publicRoutes);

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = buildServer();
  await app.listen({ port: config.PORT, host: config.HOST });
  return app;
}
