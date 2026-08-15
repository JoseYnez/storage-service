import { extname } from 'node:path';

/**
 * Normalizacion del borde: lo que entra por la API se lleva a la forma UNICA
 * que la base admite, antes de tocar la base. Los CHECK de storage.files son la
 * red final; esto es lo que hace que una peticion razonable no choque contra
 * ellos por una diferencia cosmetica.
 */

/** Tipos que vale la pena reconocer por extension cuando el cliente no lo dice. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

const DEFAULT_MIME = 'application/octet-stream';
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * Caracteres de control (C0 + DEL) — exactamente los que rechazan
 * ck_files_path y ck_files_filename. Se escriben con \u para que el codigo
 * fuente no contenga caracteres de control de verdad.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

const MAX_FILENAME_LENGTH = 255;
const MAX_PATH_LENGTH = 1024;

/**
 * Deja el content_type en la forma que exige ck_files_content_type: minusculas
 * y sin parametros ("text/plain; charset=utf-8" -> "text/plain").
 *
 * El charset se descarta a proposito: no describe el contenido almacenado sino
 * como interpretarlo, y guardarlo obligaria a que la lista blanca de MIME de
 * cada bucket enumerara todas las variantes del mismo tipo.
 *
 * Un application/octet-stream declarado se trata como "el cliente no sabe" y se
 * intenta deducir por extension: es lo que mandan por defecto casi todos los
 * clientes HTTP cuando no miran el archivo. Si tampoco hay extension conocida,
 * queda octet-stream: un tipo desconocido no es motivo para rechazar un archivo.
 */
export function normalizeContentType(
  raw: string | null | undefined,
  filename: string,
): string {
  const declared = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (MIME_PATTERN.test(declared) && declared !== DEFAULT_MIME) return declared;

  const byExtension = MIME_BY_EXTENSION[extname(filename).toLowerCase()];
  if (byExtension) return byExtension;

  return MIME_PATTERN.test(declared) ? declared : DEFAULT_MIME;
}

/**
 * Deja el nombre de archivo en la forma que exige ck_files_filename: sin
 * separadores de ruta, sin caracteres de control y acotado a 255. Un cliente
 * puede mandar "..\\..\\etc\\passwd" como nombre; lo que llega a la base es
 * "passwd".
 */
export function normalizeFilename(raw: string | null | undefined): string {
  const base = (raw ?? '')
    // Se corta por CUALQUIERA de los dos separadores: el nombre puede venir de
    // un cliente Windows y llegar a un servicio POSIX, o al reves.
    .split(/[/\\]/)
    .pop()
    ?.replace(CONTROL_CHARS, '')
    .trim();

  if (!base || base === '.' || base === '..') return 'archivo';
  return base.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Deja la ruta logica en la forma que exige ck_files_path. NO es una ruta del
 * filesystem (el servicio nunca la abre), pero se sanea como si lo fuera
 * porque termina en cabeceras HTTP, logs y URLs:
 *
 *   * barras de mas o de menos      -> una sola forma de escribir la ruta
 *   * segmentos '.' y '..'          -> se descartan: nada de "subir un nivel"
 *   * '\' y caracteres de control   -> fuera
 *
 * Si no queda nada utilizable, cae al nombre de archivo normalizado — subir sin
 * indicar ruta guarda el archivo con su propio nombre en la raiz del bucket.
 */
export function normalizePath(
  raw: string | null | undefined,
  filename: string,
): string {
  const segments = (raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.replace(CONTROL_CHARS, '').trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

  // El recorte se hace por segmentos y no con slice() sobre el string: cortar a
  // ciegas podria dejar una barra final o un segmento partido, y las dos cosas
  // violan ck_files_path.
  const kept: string[] = [];
  let length = 0;
  for (const segment of segments) {
    const added = kept.length === 0 ? segment.length : segment.length + 1;
    if (length + added > MAX_PATH_LENGTH) break;
    kept.push(segment);
    length += added;
  }

  if (kept.length === 0) return normalizeFilename(filename);
  return kept.join('/');
}
