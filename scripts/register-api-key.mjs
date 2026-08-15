// =============================================================================
// register-api-key.mjs
// =============================================================================
// Emite (o revoca) una API key server-to-server en storage.api_keys. La key en
// claro se muestra UNA SOLA VEZ por stdout: en la base queda solo su SHA-256.
//
// Uso:
//   node scripts/register-api-key.mjs --name "backend ERP" \
//     --customer 018f...-... --app 018f...-...
//
//   node scripts/register-api-key.mjs --revoke sk_ab12cd34
//
// Flags:
//   --name        (req al emitir)  nombre operativo de la key
//   --description                  descripcion libre
//   --customer                     customer_id (default: API_KEY_CUSTOMER_ID
//                                  del .env, si esta definida)
//   --app                          app_id (default: API_KEY_APP_ID del .env)
//   --revoke <prefijo>             revoca (soft delete) las keys ACTIVAS cuyo
//                                  key_prefix coincida exactamente
//
// La vigencia del par (customer, app) contra la base de ADMIN la valida quien
// ejecuta esto (o la consola de administracion, cuando el alta pase por ahi).
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
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
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withDb(fn) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('audit.user_id', $1, true),
              set_config('audit.app_name', 'storage-service:register', true),
              set_config('audit.action', 'register-api-key', true)`,
      [process.env.SERVICE_USER_ID ?? '00000000-0000-0000-0000-000000000000'],
    );
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Fallo la operacion:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function revoke(prefix) {
  await withDb(async (client) => {
    const { rows } = await client.query(
      `UPDATE storage.api_keys
          SET status = 'deleted'
        WHERE key_prefix = $1
          AND status = 'active'
        RETURNING id, name`,
      [prefix],
    );
    if (rows.length === 0) {
      console.log(`No hay keys activas con prefijo "${prefix}". Nada que revocar.`);
      return;
    }
    for (const row of rows) {
      console.log(`OK key revocada: ${row.id} ("${row.name}")`);
    }
  });
}

async function issue(args) {
  const name = args.name;
  if (!name || name === true) {
    console.error('Falta --name (nombre operativo de la key)');
    process.exit(1);
  }
  const description =
    args.description && args.description !== true ? args.description : null;

  const customerId = (args.customer && args.customer !== true ? args.customer : null)
    ?? process.env.API_KEY_CUSTOMER_ID ?? null;
  const appId = (args.app && args.app !== true ? args.app : null)
    ?? process.env.API_KEY_APP_ID ?? null;
  if (!customerId || !appId) {
    console.error('Faltan --customer y/o --app (o API_KEY_CUSTOMER_ID / API_KEY_APP_ID en .env)');
    process.exit(1);
  }
  if (!UUID_PATTERN.test(customerId) || !UUID_PATTERN.test(appId)) {
    console.error('customer_id y app_id deben ser UUIDs');
    process.exit(1);
  }

  // sk_ + 24 bytes de azar en base64url: ~192 bits de entropia.
  const plainKey = `sk_${randomBytes(24).toString('base64url')}`;
  const keyHash = createHash('sha256').update(plainKey, 'utf8').digest('hex');
  const keyPrefix = plainKey.slice(0, 11); // "sk_" + 8 visibles

  await withDb(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO storage.api_keys (customer_id, app_id, key_hash, key_prefix, name, description)
            VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id`,
      [customerId, appId, keyHash, keyPrefix, name, description],
    );
    console.log('OK api key emitida:');
    console.log(`  id          = ${rows[0].id}`);
    console.log(`  name        = ${name}`);
    console.log(`  customer_id = ${customerId}`);
    console.log(`  app_id      = ${appId}`);
    console.log(`  prefijo     = ${keyPrefix}`);
    console.log('');
    console.log('  LA KEY (guardala AHORA; no se vuelve a mostrar ni se puede recuperar):');
    console.log(`  ${plainKey}`);
    console.log('');
    console.log(`  Revocarla: node scripts/register-api-key.mjs --revoke ${keyPrefix}`);
  });
}

const args = parseArgs(process.argv);
if (args.revoke) {
  if (args.revoke === true) {
    console.error('--revoke requiere el prefijo de la key (ej: sk_ab12cd34)');
    process.exit(1);
  }
  await revoke(args.revoke);
} else {
  await issue(args);
}
