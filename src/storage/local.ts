import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
// openFile: el alias evita confundir la syscall con el metodo open() de esta
// clase, que abre contenido ya almacenado y no un temporal.
import {
  mkdir,
  open as openFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { ByteRange, StagedContent, StorageBackend } from '../types.js';
import {
  ContentMissingError,
  ContentTooLargeError,
  type StorageProvider,
  type StoredObject,
} from './provider.js';

/** Subdirectorio de trabajo. El punto lo mantiene fuera de los arboles de cliente. */
const TMP_DIR_NAME = '.tmp';

/**
 * Almacenamiento en el filesystem del propio servicio, bajo STORAGE_ROOT.
 *
 * Ciclo de vida de una subida:
 *
 *   1. stage()    -> escribe en STORAGE_ROOT/.tmp/<uuid>.part mientras calcula
 *                    sha256 y tamaño en la misma pasada. Nada del contenido
 *                    pasa por memoria completo.
 *   2. persist()  -> rename() del temporal a su ruta definitiva. rename dentro
 *                    del mismo volumen es atomico: o esta el archivo entero o
 *                    no esta, nunca a medias.
 *   3. discard()  -> si el contenido ya existia (dedup) el temporal se tira.
 *
 * Durabilidad: stage() hace fsync antes de devolver, asi que el contenido esta
 * en disco antes de que la base prometa que existe. NO se hace fsync del
 * directorio tras el rename: un corte de energia en esa ventana puede dejar la
 * fila sin archivo, que es el caso que la descarga detecta y responde 410. El
 * precio de sincronizar cada directorio no vale ese caso.
 *
 * Las rutas SIEMPRE se resuelven contra la raiz y se verifica que caigan por
 * debajo (assertInsideRoot). Hoy las genera la base y no pueden escaparse, pero
 * el proveedor no confia en quien lo llama.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly backend: StorageBackend = 'local';

  private readonly root: string;
  private readonly tmpDir: string;

  constructor(root: string = config.STORAGE_ROOT) {
    this.root = resolve(root);
    this.tmpDir = join(this.root, TMP_DIR_NAME);
  }

  async init(): Promise<void> {
    await mkdir(this.tmpDir, { recursive: true });
    logger.info({ root: this.root }, 'almacenamiento local listo');
  }

  async stage(source: Readable, maxBytes: number): Promise<StagedContent> {
    // El handle de StagedContent es opaco para el resto del servicio; en este
    // proveedor es la ruta absoluta del temporal.
    const tempPath = join(this.tmpDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let sizeBytes = 0;

    // Transform intermedio: cuenta, hashea y corta apenas se pasa del limite.
    // Cortar aca (y no despues de escribir todo) es lo que evita que una subida
    // de 10 GB llene el disco antes de ser rechazada.
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          cb(new ContentTooLargeError(maxBytes));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(source, meter, createWriteStream(tempPath));
      // fsync: que los bytes esten realmente en disco antes de que la base diga
      // que existen. 'r+' y no 'r' porque en Windows FlushFileBuffers exige
      // permiso de escritura sobre el handle.
      const fh = await openFile(tempPath, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }

    return { handle: tempPath, sha256: hash.digest('hex'), sizeBytes };
  }

  async stageBuffer(content: Buffer, maxBytes: number): Promise<StagedContent> {
    // El limite se verifica antes de escribir nada: el contenido ya esta entero
    // en memoria, asi que no hay nada que transmitir para descubrirlo.
    if (content.length > maxBytes) throw new ContentTooLargeError(maxBytes);
    return this.stage(Readable.from(content), maxBytes);
  }

  async persist(staged: StagedContent, storageKey: string): Promise<void> {
    const target = this.assertInsideRoot(storageKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(staged.handle, target);
    } catch (err) {
      // EXDEV: temporal y destino en volumenes distintos. No deberia pasar (el
      // temporal vive dentro de STORAGE_ROOT), pero si alguien monta .tmp en
      // otro disco, copiar y borrar es la salida.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await pipeline(createReadStream(staged.handle), createWriteStream(target));
      await unlink(staged.handle).catch(() => {});
    }
  }

  async discard(staged: StagedContent): Promise<void> {
    await unlink(staged.handle).catch(() => {});
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await stat(this.assertInsideRoot(storageKey));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * En disco, comprobar y abrir son dos syscalls baratas, asi que el stat
   * previo alcanza: si el archivo desapareciera entre el stat y la primera
   * lectura, el stream emitiria el error igual, y esa ventana no la cierra
   * ninguna implementacion razonable. Lo que importa del contrato es que un
   * proveedor REMOTO puede resolver esto en un solo GET — ver provider.ts.
   */
  async open(storageKey: string, range?: ByteRange): Promise<Readable> {
    const target = this.assertInsideRoot(storageKey);
    try {
      await stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ContentMissingError(storageKey);
      }
      throw err;
    }
    // start/end de createReadStream son inclusivos los dos, igual que ByteRange
    // y que el Range de HTTP: no hay que corregir el extremo. Sin tramo se lee
    // el archivo entero.
    return range === undefined
      ? createReadStream(target)
      : createReadStream(target, { start: range.start, end: range.end });
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.assertInsideRoot(storageKey), { force: true });
  }

  async sweepStaged(maxAgeSec: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.tmpDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    const cutoff = Date.now() - maxAgeSec * 1000;
    let removed = 0;

    for (const entry of entries) {
      const path = join(this.tmpDir, entry);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        await unlink(path);
        removed++;
      } catch (err) {
        // Otra instancia lo borro primero, o el archivo desaparecio entre el
        // readdir y el stat: no es un error del barrido.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        logger.warn({ err, path }, 'no se pudo barrer un temporal');
      }
    }

    return removed;
  }

  async *listContent(): AsyncIterable<StoredObject> {
    yield* this.walk(this.root);
  }

  /**
   * Recorrido recursivo bajo la raiz, salteando el area temporal (.tmp, que
   * barre sweepStaged por edad). Las claves se emiten con '/' — la misma forma
   * que storage.blobs.storage_key — aunque el filesystem use '\'.
   * Un archivo que desaparece entre el readdir y el stat no es un error: otro
   * proceso (el GC de otra instancia) lo borro primero.
   */
  private async *walk(dir: string): AsyncGenerator<StoredObject> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (dir === this.root && entry.name === TMP_DIR_NAME) continue;
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        yield* this.walk(path);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const info = await stat(path);
        yield {
          storageKey: relative(this.root, path).split(sep).join('/'),
          modifiedAtMs: info.mtimeMs,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
  }

  /**
   * Resuelve una storage_key contra la raiz y se asegura de que no salga de
   * ella. Defensa en profundidad: hoy la clave la genera la base (columna
   * GENERATED) y no puede contener '..', pero este proveedor no depende de eso.
   */
  private assertInsideRoot(storageKey: string): string {
    const target = resolve(this.root, storageKey);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`storage_key fuera de STORAGE_ROOT: ${storageKey}`);
    }
    return target;
  }
}

/** Instancia unica del proveedor configurado. */
export const storageProvider: StorageProvider = new LocalStorageProvider();
