import type { ByteRange } from '../types.js';

/**
 * Interpretacion de la cabecera Range (RFC 9110 §14).
 *
 * Tres desenlaces posibles, y el mas importante es el primero:
 *
 *   full           servir la representacion entera (200). Es la respuesta a
 *                  "no hay Range" pero TAMBIEN a "hay uno que no entiendo":
 *                  el RFC obliga a IGNORAR un Range mal formado, no a
 *                  rechazarlo. Un cliente que pide raro recibe el archivo
 *                  completo, que siempre es una respuesta correcta.
 *   partial        servir el tramo (206).
 *   unsatisfiable  el tramo esta bien escrito pero fuera del archivo (416).
 *
 * Solo se admite UN tramo. `bytes=0-9,20-29` es legal en HTTP pero obligaria a
 * responder multipart/byteranges, un formato que practicamente nadie pide y que
 * ningun reproductor necesita: se ignora y se manda el archivo entero.
 */
export type RangeOutcome =
  | { kind: 'full' }
  | { kind: 'partial'; range: ByteRange }
  | { kind: 'unsatisfiable' };

/** bytes=<primero>-<ultimo> | bytes=<primero>- | bytes=-<ultimos N> */
const BYTES_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Decide que servir a partir de las cabeceras y del tamaño real del contenido.
 * Es una funcion pura: no toca el backend, asi que un 416 se resuelve sin
 * abrir nada.
 *
 * @param rangeHeader   cabecera Range tal como llego
 * @param ifRangeHeader cabecera If-Range tal como llego
 * @param etag          ETag fuerte de la representacion, con comillas
 * @param sizeBytes     tamaño total del contenido
 */
export function resolveRange(
  rangeHeader: string | string[] | undefined,
  ifRangeHeader: string | string[] | undefined,
  etag: string,
  sizeBytes: number,
): RangeOutcome {
  const raw = first(rangeHeader)?.trim();
  if (!raw) return { kind: 'full' };

  // If-Range: "continua la descarga SOLO si el contenido sigue siendo el mismo".
  // Si no coincide, se manda el archivo entero y el cliente rehace la descarga
  // — que es justo lo que evita pegar bytes de dos versiones distintas.
  //
  // Aca la comparacion es trivial y siempre segura: el ETag es el sha256 y el
  // contenido de un id es inmutable. La forma con fecha del If-Range no se
  // soporta; como toda entrada que no se entiende, se ignora el Range.
  const ifRange = first(ifRangeHeader)?.trim();
  if (ifRange && ifRange !== etag) return { kind: 'full' };

  const match = BYTES_RANGE.exec(raw);
  if (!match) return { kind: 'full' };

  const [, startRaw = '', endRaw = ''] = match;

  // "bytes=-" no dice nada: ni primero ni ultimo.
  if (startRaw === '' && endRaw === '') return { kind: 'full' };

  // Un contenido vacio no tiene ningun byte que entregar, asi que cualquier
  // tramo pedido sobre el es insatisfacible.
  if (sizeBytes === 0) return { kind: 'unsatisfiable' };

  const lastByte = sizeBytes - 1;
  let start: number;
  let end: number;

  if (startRaw === '') {
    // Sufijo: "los ultimos N bytes". Pedir 0 ultimos bytes no tiene respuesta
    // posible; pedir mas de los que hay entrega el archivo entero.
    const suffixLength = Number(endRaw);
    if (suffixLength === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, sizeBytes - suffixLength);
    end = lastByte;
  } else {
    start = Number(startRaw);
    // Un ultimo byte mas alla del final NO es un error: se recorta. Es lo que
    // hace un cliente que pide de a bloques fijos y llega al final del archivo.
    end = endRaw === '' ? lastByte : Math.min(Number(endRaw), lastByte);
  }

  if (start > lastByte || start > end) return { kind: 'unsatisfiable' };

  return { kind: 'partial', range: { start, end } };
}

/** Una cabecera repetida llega como array; nos quedamos con la primera. */
function first(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}
