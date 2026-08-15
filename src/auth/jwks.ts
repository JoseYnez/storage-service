import { importJWK, type CryptoKey } from 'jose';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Cliente del JWKS de auth_ws (GET /auth/.well-known/keys).
 *
 * Este servicio es un RESOURCE SERVER de la plataforma: valida los access
 * tokens LOCALMENTE con la clave PUBLICA Ed25519 de cada par cliente-app, sin
 * poder emitir tokens y sin depender de auth_ws en el camino caliente:
 *
 *   * el set de claves se cachea en memoria (TTL de horas);
 *   * ante un `kid` desconocido se refresca una vez (clave nueva / rotacion),
 *     con rate-limit anti-stampede y single-flight;
 *   * si auth_ws esta caido, la ultima cache valida sigue validando: un fallo
 *     de red nunca tumba la autenticacion de este servicio.
 *
 * Cada entrada conserva el `appCode` del JWK (miembro extra del JWKS de
 * auth_ws) para saber a que app pertenece el token sin conocer su UUID.
 *
 * Portado del resource server de referencia (admin_ws/src/core/auth/jwks.ts);
 * si aparece un tercer consumidor, extraer a una lib compartida de la
 * plataforma (admin_project/libs/).
 */

const JWKS_PATH = '/auth/.well-known/keys';

/** Horas: el material publico cambia solo en alta/rotacion de contrataciones. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Ventana minima entre refrescos forzados por `kid` desconocido. */
const MIN_REFETCH_MS = 30 * 1000;
/** Corte de la peticion al JWKS para no colgar el request si auth_ws no responde. */
const FETCH_TIMEOUT_MS = 5000;

export interface VerificationKey {
  /** Clave publica lista para `jwtVerify`. */
  readonly key: CryptoKey;
  /** appCode (core.apps.code) dueño de esta clave. */
  readonly appCode: string;
}

interface RawJwk {
  readonly kty?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly alg?: string;
  readonly kid?: string;
  readonly appCode?: string;
}

let cache = new Map<string, VerificationKey>();
let cachedAt = 0;
let lastFetchAttempt = 0;
/** Single-flight: refrescos concurrentes comparten una sola peticion. */
let inflight: Promise<boolean> | null = null;

async function fetchJwks(baseUrl: string): Promise<Map<string, VerificationKey>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${JWKS_PATH}`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`JWKS respondio ${res.status}`);
    }
    const body = (await res.json()) as { keys?: RawJwk[] };
    const next = new Map<string, VerificationKey>();
    for (const jwk of body.keys ?? []) {
      if (
        jwk.kty !== 'OKP' ||
        jwk.crv !== 'Ed25519' ||
        typeof jwk.x !== 'string' ||
        typeof jwk.kid !== 'string' ||
        typeof jwk.appCode !== 'string'
      ) {
        // JWK incompleto o de otro tipo: no es seleccionable, se omite.
        continue;
      }
      const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, 'EdDSA');
      // importJWK de una clave publica OKP devuelve siempre CryptoKey, no bytes.
      if (!(key instanceof Uint8Array)) {
        next.set(jwk.kid, { key, appCode: jwk.appCode });
      }
    }
    return next;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresca la cache. Ante error (auth_ws caido) NO descarta la cache previa:
 * el servicio sigue validando con lo ultimo conocido.
 */
async function refresh(baseUrl: string): Promise<boolean> {
  if (inflight !== null) {
    return inflight;
  }
  lastFetchAttempt = Date.now();
  inflight = (async () => {
    try {
      const next = await fetchJwks(baseUrl);
      cache = next;
      cachedAt = Date.now();
      return true;
    } catch (err) {
      logger.warn({ err }, 'no se pudo refrescar el JWKS de auth_ws; se conserva la cache vigente');
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Resuelve la clave de verificacion por `kid`. Refresca si la cache caduco o
 * el `kid` no aparece (clave nueva / rotacion), respetando el rate-limit.
 * Devuelve null si tras refrescar sigue sin existir, o si la autenticacion por
 * token no esta habilitada (AUTH_WS_BASE_URL sin definir).
 */
export async function resolveVerificationKey(kid: string): Promise<VerificationKey | null> {
  const baseUrl = config.AUTH_WS_BASE_URL;
  if (baseUrl === undefined) return null;

  const now = Date.now();
  const fresh = now - cachedAt < CACHE_TTL_MS;
  const hit = cache.get(kid);

  if (hit !== undefined && fresh) {
    return hit;
  }
  // Cache caducada, o `kid` ausente y fuera de la ventana anti-stampede.
  if (!fresh || (hit === undefined && now - lastFetchAttempt > MIN_REFETCH_MS)) {
    await refresh(baseUrl);
    return cache.get(kid) ?? null;
  }
  return hit ?? null;
}
