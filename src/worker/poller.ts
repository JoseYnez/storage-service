import { hostname } from 'node:os';
import { config } from '../config/index.js';
import { withAuditContext } from '../db/audit-context.js';
import { logger } from '../logger.js';
import { storageProvider } from '../storage/local.js';
import { collectOrphanBlobs } from './gc.js';

const workerId = `${hostname()}:${process.pid}`;

/**
 * Recolector de basura. Cada WORKER_INTERVAL_MS (60 s por defecto):
 *   1. Borra temporales viejos — subidas que murieron a mitad de camino.
 *   2. Recolecta blobs sin referencias pasado el periodo de gracia.
 *
 * Los ciclos NO se solapan: cada uno se agenda cuando el anterior termina, asi
 * un lote lento no dispara otro encima. Varias INSTANCIAS si conviven sin
 * pisarse gracias a SKIP LOCKED en la seleccion de huerfanos.
 *
 * El servicio funciona sin el: sin recolector no se pierde nada, solo se
 * acumula contenido sin referencias ocupando disco. Por eso puede correr en un
 * proceso aparte (WORKER_ENABLED) o incluso en una sola instancia mientras la
 * API escala a varias.
 */
export class Worker {
  private stopped = false;
  private wakeUp: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  start(): void {
    if (this.loopPromise) return;
    logger.info(
      {
        workerId,
        intervalMs: config.WORKER_INTERVAL_MS,
        batchSize: config.WORKER_BATCH_SIZE,
        graceSec: config.GC_GRACE_SEC,
      },
      'recolector iniciado',
    );
    this.loopPromise = this.runForever();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeUp?.();
    await this.loopPromise;
    logger.info('recolector detenido');
  }

  private async runForever(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now();
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err }, 'fallo el ciclo del recolector');
      }
      const elapsed = Date.now() - started;
      await this.sleep(Math.max(0, config.WORKER_INTERVAL_MS - elapsed));
    }
  }

  private async tick(): Promise<void> {
    // 1. Temporales huerfanos. No toca la base: son archivos que nunca
    //    llegaron a tener fila.
    const sweptTemps = await storageProvider.sweepStaged(config.TMP_MAX_AGE_SEC);
    if (sweptTemps > 0) {
      logger.info({ sweptTemps }, 'temporales de subidas incompletas borrados');
    }

    // 2. Blobs sin referencias. El contexto de auditoria hace falta aunque
    //    storage.blobs no se audite: el trigger de campos de control igual
    //    puebla updated_by/deleted_by desde audit.user_id.
    const result = await withAuditContext({ action: 'worker:gc' }, (client) =>
      collectOrphanBlobs(
        client,
        storageProvider,
        config.WORKER_BATCH_SIZE,
        config.GC_GRACE_SEC,
      ),
    );

    if (result.collected > 0) {
      logger.info({ collected: result.collected }, 'blobs sin referencias recolectados');
    }
    if (result.repaired > 0) {
      logger.warn({ repaired: result.repaired }, 'contadores de referencias corregidos');
    }
  }

  /** Espera cancelable: stop() la interrumpe para cortar rapido. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }
}
