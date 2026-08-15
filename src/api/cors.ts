import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';

/**
 * CORS minimo para que un SPA llame a este servicio directo con el Bearer del
 * usuario. Lista blanca exacta de origenes (CORS_ORIGINS); sin configurar, no
 * se emite ninguna cabecera CORS y este hook ni se registra — los clientes
 * server-to-server no lo necesitan.
 *
 * Sin credenciales (Access-Control-Allow-Credentials) a proposito: la auth
 * viaja en cabeceras (Authorization / X-Api-Key), nunca en cookies, asi que no
 * hace falta abrir esa superficie.
 *
 * Debe registrarse ANTES del hook de auth: el preflight (OPTIONS) no lleva
 * credenciales y se contesta aca; autenticarlo lo romperia con un 401.
 */
export function registerCors(app: FastifyInstance): void {
  if (config.CORS_ORIGINS.length === 0) return;
  const allowed = new Set(config.CORS_ORIGINS);

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const isAllowed = typeof origin === 'string' && allowed.has(origin);

    if (isAllowed) {
      reply.header('Access-Control-Allow-Origin', origin);
      // La respuesta depende del Origin: sin Vary, un cache compartido podria
      // servirle a un origen la respuesta emitida para otro.
      reply.header('Vary', 'Origin');
      // Cabeceras que el JS del navegador necesita poder leer en descargas.
      reply.header(
        'Access-Control-Expose-Headers',
        'Content-Disposition, ETag, Content-Range, Accept-Ranges',
      );
    }

    if (req.method === 'OPTIONS') {
      if (isAllowed) {
        reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
        reply.header('Access-Control-Max-Age', '86400');
      }
      // Preflight de un origen no listado: 204 sin cabeceras CORS — el
      // navegador bloquea solo. No hay nada que autenticar.
      return reply.code(204).send();
    }
  });
}
