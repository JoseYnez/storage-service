import { config } from '../config/index.js';
import { pool, type PoolClient } from './pool.js';

/**
 * Contexto de auditoria que viaja en cada transaccion. El trigger
 * util.fn_set_audit_fields lee audit.user_id para popular created_by/updated_by,
 * y audit.fn_capture_event_log lee el resto para el event_log de las tablas
 * auditadas (files, buckets, bucket_apps). blobs esta exenta de auditoria pero
 * igual corre el trigger de campos de control, asi que user_id importa siempre.
 */
export interface AuditContext {
  /** Endpoint o tarea que origina el DML — queda en audit.action. */
  action: string;
  /** Override del usuario de servicio, si aplica. */
  userId?: string;
}

/**
 * Abre una transaccion, setea las GUC de auditoria como transaction-local
 * (set_config con is_local = true, se limpian solas al COMMIT/ROLLBACK), corre
 * el callback con el cliente ya en transaccion y hace COMMIT. Si el callback
 * lanza, hace ROLLBACK y re-lanza.
 */
export async function withAuditContext<T>(
  ctx: AuditContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // set_config(key, value, is_local=true): valido solo dentro de esta
    // transaccion. Parametrizado para no concatenar valores en el SQL.
    await client.query(
      `SELECT
         set_config('audit.user_id',  $1, true),
         set_config('audit.app_name', $2, true),
         set_config('audit.action',   $3, true)`,
      [ctx.userId ?? config.SERVICE_USER_ID, config.AUDIT_APP_NAME, ctx.action],
    );

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Si el ROLLBACK falla la conexion probablemente ya esta rota; pg la
      // descarta al liberarla. Preservamos el error original.
    }
    throw err;
  } finally {
    client.release();
  }
}
