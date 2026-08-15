// =============================================================================
// register-bucket.mjs
// =============================================================================
// Crea (o actualiza) un bucket en storage.buckets. La API NO da de alta buckets
// —es configuracion, no una operacion de la app— y sin al menos uno no se puede
// subir nada: esta es la via para dejar el servicio utilizable.
//
// Uso:
//   node scripts/register-bucket.mjs --code invoices --name "Facturas" --default
//
//   node scripts/register-bucket.mjs --code avatars --name "Avatares" \
//     --quota 1073741824 --max-file-size 5242880 \
//     --mime image/png,image/jpeg,image/webp
//
// Flags:
//   --code            (req)  code logico del bucket ("invoices", "avatars"…)
//   --name                   nombre legible (default: el code)
//   --description            descripcion libre
//   --quota                  cuota total en bytes (default: sin cuota)
//   --max-file-size          maximo por archivo en bytes (default: solo el
//                            limite global del servicio)
//   --mime                   lista blanca de MIME separada por comas
//                            (default: cualquier tipo)
//   --customer               customer_id (default: API_KEY_CUSTOMER_ID del .env)
//   --app                    si se pasa, ademas vincula ese app_id al bucket
//                            (default: API_KEY_APP_ID cuando se usa --default)
//   --default                marca el bucket como default del cliente
//                            (recomendado para la primera prueba: la subida no
//                            necesita bucket_code)
// =============================================================================

import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

loadDotenv();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true; // flag booleano
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function required(args, name) {
  if (!args[name] || args[name] === true) {
    console.error(`Falta --${name}`);
    process.exit(1);
  }
  return args[name];
}

function positiveIntOrNull(raw, flag) {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${flag} debe ser un entero positivo (bytes): ${raw}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv);

  const code = required(args, 'code');
  const name = args.name && args.name !== true ? args.name : code;
  const description = args.description && args.description !== true ? args.description : null;
  const quotaBytes = positiveIntOrNull(args.quota, 'quota');
  const maxFileSize = positiveIntOrNull(args['max-file-size'], 'max-file-size');
  const isDefault = Boolean(args.default);

  // Array vacio esta prohibido por ck_buckets_allowed_mime_types: sin --mime va
  // NULL, que es "cualquier tipo".
  const allowedMime =
    args.mime && args.mime !== true
      ? args.mime.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)
      : null;
  if (allowedMime && allowedMime.length === 0) {
    console.error('--mime no puede quedar vacio: omitilo para admitir cualquier tipo');
    process.exit(1);
  }

  const customerId = args.customer ?? process.env.API_KEY_CUSTOMER_ID;
  if (!customerId) {
    console.error('No hay customer_id: pasa --customer o define API_KEY_CUSTOMER_ID en .env');
    process.exit(1);
  }

  // El vinculo con la app solo se crea si se pide explicitamente, o si se marca
  // default (el caso "quiero que ande ya" de la primera prueba).
  const appId =
    args.app && args.app !== true
      ? args.app
      : isDefault
        ? (process.env.API_KEY_APP_ID ?? null)
        : null;

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('audit.user_id', $1, true),
              set_config('audit.app_name', 'storage-service:register', true),
              set_config('audit.action', 'register-bucket', true)`,
      [process.env.SERVICE_USER_ID ?? '00000000-0000-0000-0000-000000000000'],
    );

    // Como maximo un default activo por cliente: bajamos el anterior si aplica.
    if (isDefault) {
      await client.query(
        `UPDATE storage.buckets
            SET is_default = false
          WHERE customer_id = $1 AND is_default AND status = 'active'`,
        [customerId],
      );
    }

    // Upsert por (customer_id, code) entre filas vigentes: re-ejecutar actualiza.
    const existing = await client.query(
      `SELECT id FROM storage.buckets
        WHERE customer_id = $1 AND code = $2 AND status <> 'deleted'
        LIMIT 1`,
      [customerId, code],
    );

    let id;
    if (existing.rows[0]) {
      id = existing.rows[0].id;
      await client.query(
        `UPDATE storage.buckets SET
            name = $2, description = $3,
            quota_bytes = $4, max_file_size_bytes = $5, allowed_mime_types = $6,
            is_default = $7, status = 'active'
          WHERE id = $1`,
        [id, name, description, quotaBytes, maxFileSize, allowedMime, isDefault],
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO storage.buckets (
            customer_id, code, name, description,
            quota_bytes, max_file_size_bytes, allowed_mime_types, is_default
         ) VALUES (
            $1, $2::public.citext, $3, $4,
            $5, $6, $7, $8
         ) RETURNING id`,
        [customerId, code, name, description, quotaBytes, maxFileSize, allowedMime, isDefault],
      );
      id = inserted.rows[0].id;
    }

    if (appId) {
      // Vinculo app -> bucket. Se marca default de la app cuando el bucket es
      // el default del cliente: asi la subida sin bucket_code resuelve por el
      // paso 2 antes de llegar al 3.
      if (isDefault) {
        await client.query(
          `UPDATE storage.bucket_apps
              SET is_default = false
            WHERE customer_id = $1 AND app_id = $2 AND is_default AND status = 'active'`,
          [customerId, appId],
        );
      }

      const link = await client.query(
        `SELECT id FROM storage.bucket_apps
          WHERE bucket_id = $1 AND app_id = $2 AND status <> 'deleted'
          LIMIT 1`,
        [id, appId],
      );

      if (link.rows[0]) {
        await client.query(
          `UPDATE storage.bucket_apps
              SET is_default = $2, status = 'active'
            WHERE id = $1`,
          [link.rows[0].id, isDefault],
        );
      } else {
        await client.query(
          `INSERT INTO storage.bucket_apps (bucket_id, customer_id, app_id, is_default)
                VALUES ($1, $2, $3, $4)`,
          [id, customerId, appId, isDefault],
        );
      }
    }

    await client.query('COMMIT');
    console.log('OK bucket registrado:');
    console.log(`  id                  = ${id}`);
    console.log(`  code                = ${code}`);
    console.log(`  customer_id         = ${customerId}`);
    console.log(`  is_default          = ${isDefault}`);
    console.log(`  quota_bytes         = ${quotaBytes ?? 'sin cuota'}`);
    console.log(`  max_file_size_bytes = ${maxFileSize ?? 'solo MAX_UPLOAD_BYTES'}`);
    console.log(`  allowed_mime_types  = ${allowedMime ? allowedMime.join(', ') : 'cualquiera'}`);
    if (appId) console.log(`  app vinculada       = ${appId}`);
    if (isDefault) {
      console.log('\nAl ser default, el POST /v1/files no necesita "bucket_code".');
    } else {
      console.log(`\nComo NO es default, en el POST /v1/files pasa "bucket_code": "${code}".`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fallo el registro:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
