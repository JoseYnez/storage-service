import type { FastifyReply } from 'fastify';
import type { ZodError } from 'zod';
import { DomainError } from '../domain/errors.js';

/** Respuesta 400 uniforme para fallos de validacion zod. */
export function sendZodError(reply: FastifyReply, error: ZodError): FastifyReply {
  return reply.code(400).send({
    error: 'validation_error',
    message: 'La peticion no supero la validacion.',
    details: error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  });
}

/** Codigos estables por status para errores 4xx que no son de dominio. */
const GENERIC_4XX_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  406: 'not_acceptable',
  408: 'request_timeout',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
};

/**
 * Traduce errores a HTTP:
 *   * DomainError -> su status y codigo propios.
 *   * Errores con statusCode 4xx (los de Fastify: JSON malformado, body sobre
 *     bodyLimit, limites de multipart...) -> ese status, con un codigo estable
 *     y el mensaje del error, que en Fastify es seguro y descriptivo.
 *     Responderlos como 500 mentiria al cliente: son culpa de la peticion.
 *   * El resto -> 500 opaco.
 */
export function toHttpError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DomainError) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
    });
  }

  const statusCode =
    typeof err === 'object' && err !== null && 'statusCode' in err
      ? Number((err as { statusCode?: unknown }).statusCode)
      : Number.NaN;
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({
      error: GENERIC_4XX_CODES[statusCode] ?? 'request_error',
      message: err instanceof Error ? err.message : 'La peticion no es valida.',
    });
  }

  return reply.code(500).send({
    error: 'internal_error',
    message: 'Error interno.',
  });
}
