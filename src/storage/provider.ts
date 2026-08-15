import type { Readable } from 'node:stream';
import type { ByteRange, StagedContent, StorageBackend } from '../types.js';

/**
 * Contrato del almacenamiento fisico. El dominio nunca toca el filesystem
 * directamente: pide staging, commit y lectura a traves de esta interfaz.
 *
 * El proveedor local (disco del propio servicio) es el unico implementado hoy.
 * Uno de S3 / Azure Blob entra implementando esta misma interfaz, sin tocar el
 * dominio — igual que el CryptoProvider del smtp-service.
 *
 * Todas las operaciones toman una storage_key: la ruta RELATIVA que genera la
 * base (storage.blobs.storage_key). El proveedor la resuelve contra su raiz y
 * verifica que no se escape de ella.
 */
export interface StorageProvider {
  readonly backend: StorageBackend;

  /** Crea los directorios de trabajo. Se llama una vez al arrancar. */
  init(): Promise<void>;

  /**
   * Escribe un stream en el area temporal calculando sha256 y tamaño AL VUELO
   * (una sola pasada, sin cargar el contenido en memoria). Aborta y limpia si
   * se pasa de maxBytes.
   */
  stage(source: Readable, maxBytes: number): Promise<StagedContent>;

  /** Igual que stage() para un contenido que ya esta entero en memoria. */
  stageBuffer(content: Buffer, maxBytes: number): Promise<StagedContent>;

  /** Mueve un temporal a su ubicacion definitiva. */
  persist(staged: StagedContent, storageKey: string): Promise<void>;

  /** Borra un temporal que no se va a usar (contenido duplicado, o error). */
  discard(staged: StagedContent): Promise<void>;

  /**
   * ¿Estan los bytes de esta clave en el backend? Es una pregunta de
   * CONSISTENCIA, no el paso previo a leer: la usa la subida para detectar una
   * fila cuyo contenido se perdio y restaurarlo. Para servir contenido esta
   * open(), que responde lo mismo en un solo viaje.
   */
  exists(storageKey: string): Promise<boolean>;

  /**
   * Abre el contenido para leerlo, entero o por tramo. Lanza
   * ContentMissingError si no esta.
   *
   * Es async y resuelve la existencia POR SI MISMA a proposito. La alternativa
   * —preguntar con exists() y despues leer— cuesta un stat de mas en el
   * proveedor local, pero contra un backend remoto es un HEAD que DUPLICA la
   * latencia de cada descarga. Un proveedor remoto implementa esto con un solo
   * GET y traduce su NoSuchKey a ContentMissingError.
   *
   * Quien sirve el contenido necesita saber si falta ANTES de mandar las
   * cabeceras: una vez enviadas, un fallo a mitad del stream ya no se puede
   * convertir en un 410. Por eso el error viaja al abrir y no durante la
   * lectura.
   *
   * El tramo se pasa AL BACKEND, no se recorta despues de leer: leer 900 MB
   * para devolver 2 no seria reanudar nada. En el proveedor local son los
   * parametros de createReadStream; en uno remoto, la cabecera Range de su
   * propio GET — que es exactamente como S3 sirve rangos.
   *
   * `range` viene ya validado contra el tamaño real (ver api/range.ts): el
   * proveedor no tiene que defenderse de tramos fuera de limite.
   */
  open(storageKey: string, range?: ByteRange): Promise<Readable>;

  /** Borra contenido. No falla si ya no estaba. */
  remove(storageKey: string): Promise<void>;

  /**
   * Borra temporales mas viejos que maxAgeSec — subidas que murieron a mitad.
   * Devuelve cuantos borro.
   */
  sweepStaged(maxAgeSec: number): Promise<number>;
}

/** El contenido supera el limite admitido. La API lo traduce a 413. */
export class ContentTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`el contenido supera el maximo de ${maxBytes} bytes`);
    this.name = 'ContentTooLargeError';
  }
}

/** La fila existe pero sus bytes no estan en el backend. La API lo traduce a 410. */
export class ContentMissingError extends Error {
  constructor(readonly storageKey: string) {
    super(`el contenido no esta en el backend: ${storageKey}`);
    this.name = 'ContentMissingError';
  }
}
