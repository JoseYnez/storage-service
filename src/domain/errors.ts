/** Error de dominio con codigo HTTP asociado, para mapear en la API. */
export class DomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const BucketNotResolved = () =>
  new DomainError(
    422,
    'bucket_not_resolved',
    'No se pudo resolver un bucket: la subida no nombra ninguno por code, ' +
      'la app no tiene default y el cliente no tiene bucket por defecto.',
  );

export const BucketNotFound = (code: string) =>
  new DomainError(
    422,
    'bucket_not_found',
    `No existe un bucket activo con code "${code}" para este cliente.`,
  );

export const FileNotFound = () =>
  new DomainError(404, 'file_not_found', 'No existe el archivo solicitado.');

/**
 * La fila existe pero el contenido no esta en el backend. Es 410 y no 404 a
 * proposito: el archivo existio: decirlo permite distinguir "nunca existio" de
 * "algo se rompio", que se investigan distinto.
 */
export const FileContentGone = () =>
  new DomainError(
    410,
    'content_gone',
    'El archivo esta registrado pero su contenido ya no esta disponible.',
  );

export const FileTooLarge = (maxBytes: number) =>
  new DomainError(
    413,
    'file_too_large',
    `El archivo supera el maximo permitido (${maxBytes} bytes).`,
  );

export const MimeNotAllowed = (contentType: string, bucketCode: string) =>
  new DomainError(
    415,
    'mime_not_allowed',
    `El bucket "${bucketCode}" no admite contenido de tipo "${contentType}".`,
  );

export const QuotaExceeded = (bucketCode: string) =>
  new DomainError(
    507,
    'quota_exceeded',
    `El bucket "${bucketCode}" no tiene espacio suficiente para este archivo.`,
  );

export const InvalidSignature = () =>
  new DomainError(
    403,
    'invalid_signature',
    'El enlace de descarga no es valido.',
  );

export const LinkExpired = () =>
  new DomainError(410, 'link_expired', 'El enlace de descarga expiro.');
