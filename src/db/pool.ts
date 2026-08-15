import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  // Una subida grande puede tener la transaccion abierta mientras se escribe el
  // archivo a disco; no forzamos timeouts agresivos en el statement, pero si en
  // la conexion ociosa.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Un cliente ocioso del pool murio (p.ej. la DB se reinicio). pg lo descarta
  // solo; solo lo registramos para no matar el proceso.
  logger.error({ err }, 'error en cliente ocioso del pool de la base');
});

export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

/** Cualquier cosa sobre la que se pueda correr .query: el pool o un client. */
export type Queryable = Pick<pg.PoolClient, 'query'>;
