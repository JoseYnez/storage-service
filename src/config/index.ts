import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

// UUID cero es valido como placeholder de arranque; la validacion real de que
// el cliente/app existan la hace admin, no este servicio.
const uuid = z.string().uuid();

const boolFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3010),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  API_ENABLED: boolFromEnv.default('true'),
  WORKER_ENABLED: boolFromEnv.default('true'),

  // Detras de un reverse proxy, true hace que req.ip respete X-Forwarded-For
  // (necesario para que el rate limit cuente por cliente real y no por proxy).
  // Expuesto directo a internet debe quedar en false: el header seria forjable.
  TRUST_PROXY: boolFromEnv.default('false'),

  // ----- Rate limiting (en memoria, por IP) ---------------------------------
  // Primera linea contra abuso. En multi-instancia cada proceso cuenta por
  // separado; para un limite global compartido hace falta un store externo.
  RATE_LIMIT_DISABLED: boolFromEnv.default('false'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  SERVICE_USER_ID: uuid,
  AUDIT_APP_NAME: z.string().default('storage-service'),

  // ----- Almacenamiento -----------------------------------------------------
  // Raiz del arbol de archivos. Se resuelve a absoluta al arrancar: todo el
  // resto del servicio trabaja con rutas absolutas y verifica que lo que abre
  // este por debajo de esta.
  STORAGE_ROOT: z.string().min(1).transform((p) => resolve(p)),
  // Techo global del servicio, ademas del limite por bucket. El menor manda.
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),

  // ----- URLs firmadas de descarga -----------------------------------------
  // Clave HMAC. Generar con: npm run gen:signkey. Rotarla invalida de golpe
  // todos los enlaces emitidos, que es justamente el boton de panico.
  DOWNLOAD_SIGNING_KEY: z.string().min(32, 'DOWNLOAD_SIGNING_KEY demasiado corta'),
  DOWNLOAD_URL_TTL_SEC: z.coerce.number().int().positive().default(300),
  DOWNLOAD_URL_MAX_TTL_SEC: z.coerce.number().int().positive().default(86_400),
  // Origen publico con el que se arman los enlaces (detras de un proxy, el
  // externo, no el interno). Sin barra final.
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:3010')
    .transform((u) => u.replace(/\/+$/, '')),

  // ----- Autenticacion por access token de la plataforma (auth_ws) ----------
  // Base URL de auth_ws (sin barra final). Definirla ENCIENDE la autenticacion
  // por Bearer JWT: el servicio valida los tokens localmente contra el JWKS de
  // /auth/.well-known/keys y autoriza contra /auth/sessions/current/permissions.
  // Sin definir, el servicio solo acepta X-Api-Key (comportamiento previo).
  AUTH_WS_BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),

  // Lista blanca de origenes CORS separada por comas, para SPAs que llaman a
  // este servicio directo con el Bearer del usuario. Vacia = sin CORS (los
  // clientes server-to-server no lo necesitan).
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter((origin) => origin.length > 0),
    ),

  // ----- Recolector de basura ----------------------------------------------
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  // Un blob sin referencias no se borra hasta pasado este tiempo: margen para
  // que una subida en curso que lo esta reutilizando termine de commitear.
  GC_GRACE_SEC: z.coerce.number().int().positive().default(900),
  // Un temporal mas viejo que esto quedo de una subida que murio a mitad.
  TMP_MAX_AGE_SEC: z.coerce.number().int().positive().default(3_600),
  // Cada cuanto reconciliar el DISCO contra storage.blobs para borrar archivos
  // huerfanos (bytes cuya transaccion hizo rollback despues del persist, o
  // procesos muertos entre el rename y el COMMIT). Recorre el arbol entero:
  // por eso corre cada horas, no cada ciclo. 0 = deshabilitado.
  ORPHAN_SWEEP_INTERVAL_SEC: z.coerce.number().int().min(0).default(21_600),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Configuracion invalida:\n' + parsed.error.toString());
  process.exit(1);
}

if (parsed.data.DOWNLOAD_URL_TTL_SEC > parsed.data.DOWNLOAD_URL_MAX_TTL_SEC) {
  // eslint-disable-next-line no-console
  console.error(
    'Configuracion invalida: DOWNLOAD_URL_TTL_SEC no puede superar DOWNLOAD_URL_MAX_TTL_SEC',
  );
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
