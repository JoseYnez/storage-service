import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import type { Principal } from '../types.js';

/**
 * Auth por api-key HARDCODEADA (una sola, por ahora). No hay tabla de keys en
 * la base todavia; la key vive en config y resuelve a un unico (customer, app).
 *
 * Cuando exista storage.api_keys, esta funcion se reemplaza por un lookup
 * contra la base sin tocar el resto del servicio (mismo tipo de retorno).
 */
export function resolvePrincipal(presentedKey: string | undefined): Principal | null {
  if (!presentedKey) return null;

  // Comparacion en tiempo constante para no filtrar el largo/prefijo por timing.
  const expected = Buffer.from(config.API_KEY, 'utf8');
  const got = Buffer.from(presentedKey, 'utf8');
  if (expected.length !== got.length) return null;
  if (!timingSafeEqual(expected, got)) return null;

  return {
    customerId: config.API_KEY_CUSTOMER_ID,
    appId: config.API_KEY_APP_ID,
  };
}
