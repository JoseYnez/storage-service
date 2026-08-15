import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Principal } from '../types.js';

/**
 * Auth por API key contra storage.api_keys: el hash SHA-256 de la key
 * presentada se busca por igualdad y resuelve al (customer, app) de la fila.
 *
 * Por que un hash simple y no un KDF lento (argon2/bcrypt): las keys son
 * tokens ALEATORIOS de alta entropia (sk_ + 24 bytes), no contraseñas humanas.
 * Invertir o forzar el SHA-256 de 192 bits de azar es inviable, y un KDF lento
 * costaria decenas de ms EN CADA request server-to-server.
 *
 * Por que no hace falta comparacion en tiempo constante: lo que viaja a la
 * base es el hash, y un atacante que pudiera medir el lookup por indice
 * igual necesitaria una preimagen del hash para explotar cualquier cosa.
 *
 * La key en claro se muestra UNA vez al emitirla (scripts/register-api-key.mjs)
 * y no se almacena nunca; revocar es soft delete / status inactive en la fila.
 */
export async function resolvePrincipal(
  presentedKey: string | undefined,
): Promise<Principal | null> {
  if (!presentedKey) return null;

  const keyHash = createHash('sha256').update(presentedKey, 'utf8').digest('hex');

  const { rows } = await pool.query<{ customer_id: string; app_id: string }>(
    `SELECT customer_id, app_id
       FROM storage.api_keys
      WHERE key_hash = $1
        AND status = 'active'`,
    [keyHash],
  );
  const row = rows[0];
  if (!row) return null;

  return { via: 'api_key', customerId: row.customer_id, appId: row.app_id };
}
