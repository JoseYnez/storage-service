import type { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { FileContentGone } from '../domain/errors.js';
import { ContentMissingError, type StorageProvider } from '../storage/provider.js';
import type { ByteRange, FileContentRef } from '../types.js';
import { resolveRange } from './range.js';

/**
 * Tipos que un navegador EJECUTA si los muestra en linea. Se sirven siempre
 * como descarga, aunque el cliente pida inline.
 *
 * El motivo: el contenido lo sube un tercero y se sirve desde el origen de este
 * servicio. Un HTML o un SVG mostrado en linea corre su propio script con las
 * cookies y el origen del servicio — la definicion de XSS almacenado. Forzar la
 * descarga corta eso sin depender de que el CSP de abajo funcione en todos los
 * navegadores.
 */
const NEVER_INLINE = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
]);

/**
 * Escribe la respuesta de contenido: cabeceras, condicional por ETag y el
 * stream de bytes. Comun a la descarga con API key y a la de enlace firmado.
 */
export async function sendContent(
  req: FastifyRequest,
  reply: FastifyReply,
  storage: StorageProvider,
  ref: FileContentRef,
  attachment: boolean,
): Promise<FastifyReply> {
  // El sha256 ES el ETag: el contenido es inmutable y esta direccionado por su
  // hash, asi que dos respuestas con el mismo ETag son literalmente los mismos
  // bytes. Fuerte, no debil.
  const etag = `"${ref.sha256}"`;

  // Validacion condicional PRIMERO: un 304 no necesita el contenido, asi que ni
  // se abre. Contra un backend remoto eso es un viaje de red que no se paga.
  // El ETag va en el 304 porque RFC 7232 lo exige.
  if (matchesEtag(req.headers['if-none-match'], etag)) {
    setCacheHeaders(reply, etag);
    return reply.code(304).send();
  }

  // El tramo se resuelve sin tocar el backend: es aritmetica sobre el tamaño
  // que ya trae la fila, asi que un 416 se contesta sin abrir nada.
  const outcome = resolveRange(
    req.headers.range,
    req.headers['if-range'],
    etag,
    ref.sizeBytes,
  );

  if (outcome.kind === 'unsatisfiable') {
    // Content-Range con '*' es lo que le dice al cliente cual es el tamaño real
    // para que reintente bien. Sin ETag: un error no es una representacion
    // cacheable.
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Range', `bytes */${ref.sizeBytes}`);
    return reply.code(416).send({
      error: 'range_not_satisfiable',
      message: 'El tramo solicitado esta fuera del archivo.',
    });
  }

  const range: ByteRange | undefined =
    outcome.kind === 'partial' ? outcome.range : undefined;

  // Se abre ANTES de escribir NADA en la respuesta: un contenido ausente tiene
  // que poder convertirse en un 410, y con cabeceras ya enviadas no se puede.
  // open() resuelve existencia y lectura de una sola vez — contra un backend
  // remoto, preguntar primero costaria otro viaje por descarga.
  //
  // Que las cabeceras se seteen DESPUES no es cosmetico: si se setearan antes,
  // la respuesta de error las arrastraria, y un 410 saldria con el ETag de un
  // contenido que no existe — algo contra lo que un cliente podria revalidar.
  let content: Readable;
  try {
    content = await storage.open(ref.storageKey, range);
  } catch (err) {
    if (err instanceof ContentMissingError) throw FileContentGone();
    throw err;
  }

  const disposition = attachment || NEVER_INLINE.has(ref.contentType)
    ? 'attachment'
    : 'inline';

  setCacheHeaders(reply, etag);
  // Anunciar el soporte de tramos es parte del contrato: un reproductor decide
  // si puede buscar dentro del video mirando esta cabecera, no probando.
  reply.header('Accept-Ranges', 'bytes');
  // El navegador no adivina el tipo: se respeta el content_type almacenado.
  reply.header('X-Content-Type-Options', 'nosniff');
  // Segunda linea de defensa sobre NEVER_INLINE: aunque algo se muestre en
  // linea, no puede cargar ni ejecutar nada.
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('Content-Type', ref.contentType);
  reply.header('Content-Disposition', contentDisposition(disposition, ref.filename));

  if (range) {
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${ref.sizeBytes}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return reply.code(206).send(content);
  }

  reply.header('Content-Length', ref.sizeBytes);
  return reply.send(content);
}

/**
 * Contenido privado: puede cachearlo el cliente, nunca un proxy compartido.
 * must-revalidate obliga a revalidar contra el ETag en vez de servir viejo.
 */
function setCacheHeaders(reply: FastifyReply, etag: string): void {
  reply.header('ETag', etag);
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
}

/** If-None-Match: '*' o una lista de ETags. W/ se ignora — los nuestros son fuertes. */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return false;
  if (raw.trim() === '*') return true;
  return raw
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}

/**
 * Content-Disposition segun RFC 6266: un filename ASCII para clientes viejos y
 * un filename* codificado para el nombre real. El nombre viene de quien subio
 * el archivo, asi que del ASCII se saca todo lo que pueda cerrar la comilla o
 * escapar de la cabecera.
 */
function contentDisposition(disposition: string, filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
