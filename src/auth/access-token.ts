import { decodeProtectedHeader, jwtVerify } from 'jose';
import { resolveVerificationKey } from './jwks.js';

/**
 * Verificacion LOCAL del access token de la plataforma. Este servicio nunca
 * emite ni llama a auth_ws para validar: comprueba firma Ed25519 + exp +
 * issuer contra la clave PUBLICA del JWKS. El tenant viaja SIEMPRE como claim
 * (`customer_id`), nunca como parametro.
 *
 * A diferencia de la consola admin (que solo acepta tokens de SU app), storage
 * acepta el token de CUALQUIER app de la plataforma: es un servicio
 * transversal y el alcance real sale de los claims (customer_id + app_id) mas
 * los permisos storage.* de la tripleta — el mismo criterio que la superficie
 * tenant de admin_ws (decision #23).
 */

/** Emisor esperado (auth_ws es el unico firmador de la plataforma). */
const ISSUER = 'auth_ws';

/** Claims verificados del access token (espejo del contrato de auth_ws). */
export interface AccessTokenClaims {
  /** user_id global (claim `sub`). */
  readonly sub: string;
  /** app_customer_user_id (la tripleta) — claim `acu`. */
  readonly acu: string;
  /** customer_id (tenant). */
  readonly customerId: string;
  /** app_id de la contratacion cliente-app. */
  readonly appId: string;
  /** core.apps.code de esa app, resuelto del JWK que firmo el token. */
  readonly appCode: string;
  /** session id = auth.app_customer_user_sessions.id (claim `sid`). */
  readonly sid: string;
  /** iat del JWT (segundos UNIX). */
  readonly issuedAt: number;
  /** exp del JWT (segundos UNIX). */
  readonly expiresAt: number;
}

/**
 * Verifica un access token de cualquier app de la plataforma. Devuelve null
 * ante cualquier fallo (respuesta opaca: no se distingue el motivo).
 */
export async function verifyPlatformAccessToken(
  token: string,
): Promise<AccessTokenClaims | null> {
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') {
    return null;
  }

  const resolved = await resolveVerificationKey(header.kid);
  if (resolved === null) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, resolved.key, {
      issuer: ISSUER,
      algorithms: ['EdDSA'],
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.acu !== 'string' ||
      typeof payload.customer_id !== 'string' ||
      typeof payload.app_id !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      acu: payload.acu,
      customerId: payload.customer_id,
      appId: payload.app_id,
      appCode: resolved.appCode,
      sid: payload.sid,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    // Firma invalida, expirado o issuer distinto.
    return null;
  }
}
