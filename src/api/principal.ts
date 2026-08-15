import type { FastifyRequest } from 'fastify';
import type { Principal } from '../types.js';

/**
 * Identidad de la peticion. El hook onRequest de server.ts garantiza que
 * existe en toda ruta no publica; si falta, es un bug de wiring — una ruta
 * quedo del lado publico sin quererlo — y no un caso a manejar con un 401.
 */
export function principalOf(req: FastifyRequest): Principal {
  const principal = req.principal;
  if (!principal) throw new Error('principal ausente tras el hook de auth');
  return principal;
}
