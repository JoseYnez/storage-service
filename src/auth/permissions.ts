import { config } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Cliente de permisos contra auth_ws: GET /auth/sessions/current/permissions
 * con el Bearer del request. auth_ws re-verifica la firma Y la validez de la
 * sesion en BD, asi que una sesion revocada pierde acceso aqui aunque su JWT
 * siga criptograficamente vigente — es el enforcement de revocacion.
 *
 * Cache por sesion (sid):
 *   * FRESH_TTL: ventana normal — acota latencia y trafico hacia auth_ws.
 *   * STALE_MAX: si auth_ws no responde, una entrada vencida sigue valiendo
 *     hasta este tope (con warn). A diferencia de admin_ws, este servicio NO
 *     comparte base con auth_ws, asi que no existe la degradacion a
 *     auth.fn_has_permission local: pasado el tope, se responde 503
 *     (fail-closed — la indisponibilidad nunca abre acceso).
 */

/** Ventana normal de la cache por sesion. */
const FRESH_TTL_MS = 60_000;
/** Tope de uso de una entrada vencida cuando auth_ws no responde. */
const STALE_MAX_MS = 5 * 60_000;
/** Timeout de la consulta: mejor degradar rapido que colgar el request. */
const FETCH_TIMEOUT_MS = 3_000;
/** Tope de entradas: al superarlo se purgan las vencidas (barrido perezoso). */
const CACHE_MAX_ENTRIES = 5_000;

export type PermissionsLookup =
  | { readonly kind: 'ok'; readonly permissions: ReadonlySet<string> }
  /** auth_ws rechazo el token/sesion (revocada): mas autoridad que la firma local. */
  | { readonly kind: 'unauthorized' }
  /** auth_ws inalcanzable y sin cache utilizable: el llamador debe fail-closed. */
  | { readonly kind: 'unavailable' };

interface CacheEntry {
  readonly permissions: ReadonlySet<string>;
  readonly fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function pruneIfNeeded(nowMs: number): void {
  if (cache.size <= CACHE_MAX_ENTRIES) {
    return;
  }
  for (const [sid, entry] of cache) {
    if (nowMs - entry.fetchedAt > STALE_MAX_MS) {
      cache.delete(sid);
    }
  }
  // Si tras purgar sigue desbordada (avalancha de sesiones), se vacia: la
  // cache es una optimizacion, nunca un requisito de correctitud.
  if (cache.size > CACHE_MAX_ENTRIES) {
    cache.clear();
  }
}

/** Entrada vencida pero dentro del tope de gracia ante caida de auth_ws. */
function staleFallback(sid: string, now: number): PermissionsLookup {
  const entry = cache.get(sid);
  if (entry !== undefined && now - entry.fetchedAt <= STALE_MAX_MS) {
    logger.warn(
      { sid },
      'auth_ws no disponible: autorizando con permisos cacheados vencidos (gracia)',
    );
    return { kind: 'ok', permissions: entry.permissions };
  }
  return { kind: 'unavailable' };
}

/**
 * Permisos efectivos de la sesion `sid`, consultados a auth_ws con el Bearer
 * del request. Cachea por sesion durante FRESH_TTL_MS.
 */
export async function getSessionPermissions(
  sid: string,
  bearerToken: string,
): Promise<PermissionsLookup> {
  const baseUrl = config.AUTH_WS_BASE_URL;
  if (baseUrl === undefined) {
    // Sin auth_ws configurado no deberia existir un principal por token.
    return { kind: 'unavailable' };
  }

  const now = Date.now();
  const hit = cache.get(sid);
  if (hit !== undefined && now - hit.fetchedAt < FRESH_TTL_MS) {
    return { kind: 'ok', permissions: hit.permissions };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/auth/sessions/current/permissions`, {
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return staleFallback(sid, now);
  }

  if (response.status === 401) {
    cache.delete(sid);
    return { kind: 'unauthorized' };
  }
  if (!response.ok) {
    return staleFallback(sid, now);
  }

  let body: { permissions?: unknown };
  try {
    body = (await response.json()) as { permissions?: unknown };
  } catch {
    return staleFallback(sid, now);
  }
  if (!Array.isArray(body.permissions)) {
    return staleFallback(sid, now);
  }

  const permissions: ReadonlySet<string> = new Set(
    body.permissions.filter((p): p is string => typeof p === 'string'),
  );
  pruneIfNeeded(now);
  cache.set(sid, { permissions, fetchedAt: now });
  return { kind: 'ok', permissions };
}
