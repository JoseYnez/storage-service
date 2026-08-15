import type { FastifyInstance } from 'fastify';
import { startServer } from './api/server.js';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { storageProvider } from './storage/local.js';
import { Worker } from './worker/poller.js';

/**
 * Punto de entrada. Segun los flags API_ENABLED / WORKER_ENABLED arranca la API
 * HTTP, el recolector de basura, o ambos en el mismo proceso. Para escalar, se
 * corre este binario dos veces con flags distintos (API en uno, recolector en
 * otro) — o varias instancias de API contra un solo recolector.
 *
 * Ambos modos necesitan el almacenamiento inicializado: la API para escribir,
 * el recolector para borrar.
 */
async function main(): Promise<void> {
  if (!config.API_ENABLED && !config.WORKER_ENABLED) {
    logger.error('API_ENABLED y WORKER_ENABLED estan ambos en false: nada que hacer');
    process.exit(1);
  }

  await storageProvider.init();

  let server: FastifyInstance | null = null;
  let worker: Worker | null = null;

  if (config.API_ENABLED) {
    server = await startServer();
    logger.info({ port: config.PORT }, 'API HTTP escuchando');
  }

  if (config.WORKER_ENABLED) {
    worker = new Worker();
    worker.start();
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'apagando…');
    try {
      if (worker) await worker.stop();
      if (server) await server.close();
      await pool.end();
    } catch (err) {
      logger.error({ err }, 'error durante el apagado');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fallo al arrancar el servicio');
  process.exit(1);
});
