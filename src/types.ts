/** Backend fisico del contenido — espejo de storage.storage_backend. */
export type StorageBackend = 'local';

/** Identidad resuelta desde la API key. */
export interface Principal {
  customerId: string;
  appId: string;
}

/** Bucket resuelto para una subida, con sus limites ya cargados. */
export interface ResolvedBucket {
  id: string;
  code: string;
  quotaBytes: number | null;
  maxFileSizeBytes: number | null;
  /** null = sin lista blanca: cualquier MIME entra. */
  allowedMimeTypes: string[] | null;
}

/** Archivo logico tal como lo devuelve la API. */
export interface FileMetadata {
  id: string;
  bucketCode: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  metadata: unknown | null;
  createdAt: string;
  updatedAt: string;
}

/** Lo que hace falta para servir una descarga: metadata + donde estan los bytes. */
export interface FileContentRef {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  backend: StorageBackend;
  storageKey: string;
}

/**
 * Tramo de bytes a leer, con AMBOS extremos INCLUSIVOS — como el Range de HTTP
 * y como el {start, end} de createReadStream, que por suerte coinciden. Un
 * tramo de un solo byte es { start: n, end: n }.
 */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Contenido ya escrito en el area temporal del proveedor, con su identidad
 * calculada mientras se escribia. Es lo que se le entrega al commit para que lo
 * mueva a su lugar definitivo (o lo descarte, si el contenido ya existia).
 */
export interface StagedContent {
  /**
   * Referencia OPACA al temporal. Solo la interpreta el proveedor que la creo:
   * para el local es una ruta absoluta en disco, para uno remoto seria una
   * clave temporal en el bucket o el id de una subida multiparte.
   *
   * Nada fuera del proveedor la lee — el dominio solo usa sha256 y sizeBytes.
   * Que sea string es por comodidad, no una promesa de que sea una ruta.
   */
  handle: string;
  sha256: string;
  sizeBytes: number;
}
