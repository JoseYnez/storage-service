import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { InvalidSignature, LinkExpired } from '../domain/errors.js';

/**
 * Enlaces de descarga firmados (HMAC-SHA256), SIN estado en la base.
 *
 * Lo que se firma es "este id de archivo, hasta este instante". La firma ES la
 * autorizacion: quien la presenta puede leer ese archivo y solo ese, sin API
 * key. Sirve para poner el enlace directo en un <img>/<a> o pasarselo a un
 * usuario final sin proxear la descarga por el backend de la app.
 *
 * Sin tabla de tokens a proposito:
 *   * un enlace no necesita historia — dura minutos y se verifica solo;
 *   * verificarlo no toca la base, asi que servir contenido no compite con las
 *     escrituras;
 *   * no hay basura que recolectar.
 * El precio es que un enlace emitido NO se puede revocar de a uno: para cortar
 * todos de golpe se rota DOWNLOAD_SIGNING_KEY (invalida los ya emitidos en el
 * acto). Si algun dia hace falta revocacion individual, ahi si hace falta
 * estado y es una fase aparte.
 */

export interface SignedLink {
  url: string;
  expiresAt: string;
  expiresInSec: number;
}

/**
 * Emite el enlace. ttlSec se acota a DOWNLOAD_URL_MAX_TTL_SEC: un cliente no
 * puede pedirse un enlace eterno.
 */
export function issueSignedLink(fileId: string, ttlSec: number): SignedLink {
  const ttl = Math.min(Math.max(ttlSec, 1), config.DOWNLOAD_URL_MAX_TTL_SEC);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const sig = sign(fileId, expires);

  const url =
    `${config.PUBLIC_BASE_URL}/v1/public/files/${fileId}/content` +
    `?expires=${expires}&sig=${sig}`;

  return {
    url,
    expiresAt: new Date(expires * 1000).toISOString(),
    expiresInSec: ttl,
  };
}

/**
 * Verifica un enlace. Lanza InvalidSignature o LinkExpired; si vuelve, el
 * portador puede leer ese archivo.
 *
 * La firma se verifica ANTES que el vencimiento: sin firma valida no se
 * confirma siquiera que el id exista o que alguna vez se haya emitido un
 * enlace para el.
 */
export function verifySignedLink(
  fileId: string,
  expiresRaw: string,
  presentedSig: string,
): void {
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires <= 0) throw InvalidSignature();

  const expected = Buffer.from(sign(fileId, expires), 'utf8');
  const got = Buffer.from(presentedSig, 'utf8');

  // Comparacion en tiempo constante. El largo se compara aparte porque
  // timingSafeEqual exige buffers del mismo tamaño; el largo de una firma no
  // es secreto (es siempre el mismo).
  if (expected.length !== got.length) throw InvalidSignature();
  if (!timingSafeEqual(expected, got)) throw InvalidSignature();

  if (expires < Math.floor(Date.now() / 1000)) throw LinkExpired();
}

/**
 * HMAC sobre "id\nexpires". El separador \n no puede aparecer en ninguno de los
 * dos campos (uno es UUID, el otro un entero), asi que dos entradas distintas
 * no pueden producir el mismo mensaje firmado.
 *
 * La clave se usa tal cual viene de la config: son >=32 caracteres generados al
 * azar (npm run gen:signkey), no una contraseña elegida por una persona.
 */
function sign(fileId: string, expires: number): string {
  return createHmac('sha256', config.DOWNLOAD_SIGNING_KEY)
    .update(`${fileId}\n${expires}`)
    .digest('base64url');
}
