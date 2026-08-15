import type { FastifyInstance } from 'fastify';
import { config } from '../config/index.js';

/**
 * Rate limiting por IP, en memoria y sin dependencias — portado del patron de
 * auth_ws. Ventana fija: N peticiones por IP cada RATE_LIMIT_WINDOW_SEC.
 *
 * Exenciones:
 *   * /health* — las probes de liveness/readiness martillean por diseño.
 *   * OPTIONS — el preflight lo emite el navegador, no el cliente; limitarlo
 *     rompe CORS antes que frenar abuso.
 *
 * LIMITACION: el contador vive en el proceso. En un despliegue multi-instancia
 * cada instancia cuenta por separado — un limite global compartido exige un
 * store externo (Redis). Con TRUST_PROXY=true req.ip respeta X-Forwarded-For.
 */

interface Bucket {
  count: number;
  /** epoch ms en que se reinicia la ventana. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/** Barrido perezoso de buckets vencidos: acota el Map sin timer dedicado. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function registerRateLimit(app: FastifyInstance): void {
  if (config.RATE_LIMIT_DISABLED) return;

  const windowMs = config.RATE_LIMIT_WINDOW_SEC * 1000;
  const max = config.RATE_LIMIT_MAX;

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0] ?? req.url;
    if (path === '/health' || path.startsWith('/health/')) return;

    const now = Date.now();
    sweep(now);

    let bucket = buckets.get(req.ip);
    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(req.ip, bucket);
    }
    bucket.count += 1;

    reply.header('X-RateLimit-Limit', String(max));
    reply.header('X-RateLimit-Remaining', String(Math.max(max - bucket.count, 0)));

    if (bucket.count > max) {
      const retryAfterSec = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1);
      reply.header('Retry-After', String(retryAfterSec));
      return reply.code(429).send({
        error: 'too_many_requests',
        message: 'Demasiadas peticiones desde esta IP. Esperar y reintentar.',
      });
    }
  });
}
