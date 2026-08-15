import { z } from 'zod';
import { config } from '../config/index.js';

// Se valida en el borde con las MISMAS reglas que los CHECK de las tablas, para
// devolver 400 legibles en vez de chocar contra el constraint a ciegas. Lo que
// no es una regla sino una diferencia de forma (mayusculas del MIME, barras de
// mas en la ruta) NO se rechaza: se normaliza en domain/normalize.ts.

const bucketCode = z.string().trim().min(1).max(255);
const logicalPath = z.string().trim().min(1).max(1024);
const filename = z.string().trim().min(1).max(255);
const contentType = z.string().trim().min(1).max(255);
const metadata = z.record(z.unknown());

/** Base64 estandar, sin espacios ni saltos: lo que produce Buffer.toString('base64'). */
const base64 = z
  .string()
  .min(1)
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0, {
    message: 'content_base64 no es base64 valido',
  });

/**
 * Subida en JSON. El contenido viaja en base64 dentro del body: comodo de
 * consumir, pero infla ~33% y se carga entero en memoria. Para archivos
 * grandes, multipart.
 */
export const uploadJsonBodySchema = z.object({
  bucket_code: bucketCode.optional(),
  path: logicalPath.optional(),
  filename,
  content_type: contentType.optional(),
  content_base64: base64,
  metadata: metadata.optional(),
});

export type UploadJsonBody = z.infer<typeof uploadJsonBodySchema>;

/**
 * Campos de texto de una subida multipart. Llegan siempre como string (es lo
 * unico que hay en un form), incluido metadata, que viaja como JSON serializado.
 */
export const uploadMultipartFieldsSchema = z.object({
  bucket_code: bucketCode.optional(),
  path: logicalPath.optional(),
  filename: filename.optional(),
  content_type: contentType.optional(),
  metadata: z
    .string()
    .transform((raw, ctx) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('debe ser un objeto JSON');
        }
        return parsed as Record<string, unknown>;
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `metadata invalido: ${(err as Error).message}`,
        });
        return z.NEVER;
      }
    })
    .optional(),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /v1/files sirve dos consultas distintas segun venga `path` o no:
 *   con path -> el archivo exacto de esa ruta
 *   sin path -> listado del bucket, opcionalmente filtrado por prefijo
 */
export const listFilesQuerySchema = z.object({
  bucket_code: bucketCode.optional(),
  path: logicalPath.optional(),
  prefix: z.string().trim().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(1024).optional(),
});

export const linkBodySchema = z
  .object({
    expires_in_sec: z.coerce
      .number()
      .int()
      .min(1)
      .max(config.DOWNLOAD_URL_MAX_TTL_SEC)
      .optional(),
  })
  // El body entero es opcional: pedir un enlace sin decir nada usa el TTL por
  // defecto de la configuracion.
  .default({});

export const signedDownloadQuerySchema = z.object({
  expires: z.string().min(1),
  sig: z.string().min(1),
  /** ?download=1 fuerza descarga; por defecto el navegador muestra en linea. */
  download: z.enum(['0', '1', 'true', 'false']).optional(),
});

export const downloadQuerySchema = z.object({
  download: z.enum(['0', '1', 'true', 'false']).optional(),
});

/** Interpreta el flag ?download= de las dos rutas de contenido. */
export function wantsAttachment(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}
