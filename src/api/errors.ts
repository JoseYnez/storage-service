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

/** Traduce errores de dominio a HTTP; el resto es 500. */
export function toHttpError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DomainError) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
    });
  }
  return reply.code(500).send({
    error: 'internal_error',
    message: 'Error interno.',
  });
}
