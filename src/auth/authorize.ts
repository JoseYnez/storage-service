import type { FastifyRequest } from 'fastify';
import { principalOf } from '../api/principal.js';
import {
  AuthUnavailable,
  PermissionDenied,
  SessionInvalid,
} from '../domain/errors.js';
import { getSessionPermissions } from './permissions.js';

/**
 * Autorizacion declarativa por operacion, para principals por ACCESS TOKEN.
 *
 * Los codigos son los canonico-punteados del catalogo auth.permissions de la
 * plataforma, registrados POR APP (uq_permissions_app_id_code): cada app que
 * use storage da de alta estos cuatro codigos en su catalogo y los reparte via
 * roles. Una API key (server-to-server) no pasa por aca: es un canal confiable
 * con acceso completo al (customer, app) de la key, igual que smtp-service.
 */
export const STORAGE_PERMISSIONS = {
  /** Listar buckets/archivos, leer metadata y descargar contenido. */
  read: 'storage.files.read',
  /** Subir (incluye reemplazar una ruta ocupada). */
  write: 'storage.files.write',
  /** Borrado logico. */
  delete: 'storage.files.delete',
  /** Emitir enlaces firmados de descarga (capability sin API key). */
  share: 'storage.files.share',
} as const;

export type StoragePermission =
  (typeof STORAGE_PERMISSIONS)[keyof typeof STORAGE_PERMISSIONS];

/**
 * Exige `permission` sobre la tripleta del token del request. Lanza el error
 * de dominio correspondiente (401 sesion revocada / 403 sin permiso / 503
 * auth_ws inalcanzable); si vuelve, la operacion esta autorizada.
 *
 * Para principals via api_key es un no-op: el RBAC es por usuario final.
 */
export async function requirePermission(
  req: FastifyRequest,
  permission: StoragePermission,
): Promise<void> {
  const principal = principalOf(req);
  if (principal.via === 'api_key') return;

  const lookup = await getSessionPermissions(principal.sessionId, principal.token);

  if (lookup.kind === 'unauthorized') throw SessionInvalid();
  if (lookup.kind === 'unavailable') throw AuthUnavailable();
  if (!lookup.permissions.has(permission)) throw PermissionDenied(permission);
}
