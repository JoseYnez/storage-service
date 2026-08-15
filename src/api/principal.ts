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

/**
 * Contexto de actor para la auditoria: con un access token, el usuario y la
 * sesion REALES quedan en created_by/updated_by y en
 * audit.event_log.app_user_id / app_session_id; con API key no hay usuario
 * final y el trigger cae al usuario de servicio (SERVICE_USER_ID).
 */
export function actorOf(principal: Principal): { userId?: string; sessionId?: string } {
  return principal.via === 'access_token'
    ? { userId: principal.userId, sessionId: principal.sessionId }
    : {};
}
