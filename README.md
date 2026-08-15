# storage-service

Servicio de **almacenamiento de archivos** sobre el schema `storage` de la base
del proyecto. Los bytes viven en el disco local (`STORAGE_ROOT`); la base guarda
qué archivos hay, dónde encontrarlos y quién los subió. Dos responsabilidades:

1. **API HTTP** — subir, listar, descargar y borrar archivos, y emitir enlaces
   de descarga temporales.
2. **Recolector** — barrido cada 60 s que borra del disco el contenido que ya no
   referencia ningún archivo, y los temporales de subidas que murieron a mitad.

Ambos pueden correr en el mismo proceso o separados (flags `API_ENABLED` /
`WORKER_ENABLED`). Varias instancias del recolector conviven sin pisarse gracias
a `FOR UPDATE SKIP LOCKED`.

## Stack

Node.js ≥ 20 + TypeScript · Fastify · @fastify/multipart · node-postgres (`pg`) ·
zod · pino.

## Puesta en marcha

```bash
cd storage-service
npm install
cp .env.example .env       # completar valores
npm run gen:apikey         # genera una API_KEY
npm run gen:signkey        # genera la DOWNLOAD_SIGNING_KEY
npm run register:bucket -- --code invoices --name "Facturas" --default
npm run build && npm start
# o en desarrollo:
npm run dev
```

Requiere la base ya instalada (ver `../db/init.sql`). **Sin al menos un bucket no
se puede subir nada**: el alta de buckets no pasa por la API (es configuración),
la hace `scripts/register-bucket.mjs`.

## Configuración

Todo por variables de entorno — ver [.env.example](.env.example). Claves:

| Variable | Qué hace |
| --- | --- |
| `API_ENABLED` / `WORKER_ENABLED` | Qué arranca este proceso |
| `DATABASE_URL` | Conexión a PostgreSQL |
| `API_KEY` | API key **hardcodeada** (una sola, por ahora) |
| `API_KEY_CUSTOMER_ID` / `API_KEY_APP_ID` | Cliente y app asociados a esa key |
| `SERVICE_USER_ID` | UUID de servicio → `created_by`/`updated_by` de los archivos |
| `STORAGE_ROOT` | Raíz del árbol de archivos. **Acá vive todo el contenido** |
| `MAX_UPLOAD_BYTES` | Techo global por archivo (el del bucket puede ser menor) |
| `DOWNLOAD_SIGNING_KEY` | Clave HMAC de los enlaces temporales |
| `PUBLIC_BASE_URL` | Origen con el que se arman los enlaces (el externo) |
| `GC_GRACE_SEC` | Cuánto espera el recolector antes de borrar contenido sin referencias |

> **Auth**: por ahora una única API key en config. No hay tabla de keys en la
> base todavía; cuando exista `storage.api_keys`, se reemplaza sólo
> `src/auth/api-key.ts` sin tocar el resto.

## API

Todas las rutas exigen el header `X-Api-Key: <API_KEY>`, salvo `/health` y la
descarga por enlace firmado (`/v1/public/...`), donde la firma **es** la
autorización. El `customer_id`/`app_id` salen de la key, nunca del body.

### `POST /v1/files` — subir

Acepta las dos formas, según el `Content-Type`:

**multipart/form-data** — el archivo se escribe a disco en streaming, sin pasar
por memoria. Es la vía para archivos grandes.

| Campo | |
| --- | --- |
| `file` | el archivo (requerido) |
| `bucket_code` | opcional, elige bucket por code |
| `path` | opcional, ruta lógica; por defecto el nombre del archivo |
| `filename` | opcional, pisa el nombre del archivo subido |
| `content_type` | opcional, pisa el MIME declarado por el cliente |
| `metadata` | opcional, objeto JSON serializado |

**application/json** — el contenido en base64 dentro del body. Más cómodo de
consumir, pero infla ~33% y se carga entero en memoria.

```jsonc
{
  "filename": "factura-4711.pdf",       // requerido
  "content_base64": "JVBERi0xLjQK…",    // requerido
  "path": "2026/08/factura-4711.pdf",   // opcional, default: filename
  "bucket_code": "invoices",            // opcional
  "content_type": "application/pdf",    // opcional, se deduce por extensión
  "metadata": { "order_id": "4711" }    // opcional, JSONB libre
}
```

**Resolución de bucket** (orden canónico): `bucket_code` → default de la app →
default del cliente → error `422` si nada aplica.

Respuestas:
- `201` archivo guardado.
- `400` validación · `401` sin API key · `413` supera el tamaño máximo ·
  `415` MIME no admitido por el bucket · `422` bucket no resoluble ·
  `507` cuota del bucket agotada.

```jsonc
{
  "id": "…uuid…", "bucket_code": "invoices", "path": "2026/08/factura-4711.pdf",
  "filename": "factura-4711.pdf", "content_type": "application/pdf",
  "size_bytes": 51234, "sha256": "…",
  "deduplicated": false,   // true: el contenido ya estaba, se reusó en disco
  "replaced": false        // true: esa ruta ya existía y fue reemplazada
}
```

### `GET /v1/files/:id` — metadata por id
### `GET /v1/files?path=…` — metadata por la ruta con que se guardó

Sirve para volver a pedir un archivo **sin haber guardado el id**.

### `GET /v1/files?prefix=…&limit=…&cursor=…` — listado

Paginado por cursor sobre la ruta. `next_cursor` viene en la respuesta; `null`
significa que no hay más.

### `GET /v1/files/:id/content` — descargar con API key

Devuelve los bytes con `ETag` (el sha256), `Content-Disposition` y soporte de
`If-None-Match` (`304`). `?download=1` fuerza descarga en vez de vista en línea.

### `POST /v1/files/:id/link` — enlace temporal firmado

```jsonc
{ "expires_in_sec": 300 }   // opcional, tope DOWNLOAD_URL_MAX_TTL_SEC
```

Devuelve una URL que descarga **sin API key** hasta que vence — para poner en un
`<img>`/`<a>` o pasarle a un usuario final:

```jsonc
{ "url": "https://…/v1/public/files/<id>/content?expires=…&sig=…",
  "expires_at": "2026-08-12T18:05:00.000Z", "expires_in_sec": 300 }
```

`403` si la firma no valida, `410` si venció.

### `DELETE /v1/files/:id` — borrado lógico

`204`. La fila queda como `deleted` (con quién y cuándo, auditado) y el contenido
se lo lleva el recolector si nadie más lo usa.

### `GET /v1/buckets` — buckets del cliente y sus límites

## Cómo se guardan los archivos

Tres piezas, y la separación es lo que hace todo lo demás posible:

- **`storage.files`** — el archivo lógico: una ruta dentro de un bucket. Es lo
  que la app nombra y lo que se audita.
- **`storage.blobs`** — el contenido, direccionado por su SHA-256. Varios
  archivos lógicos pueden apuntar al mismo blob.
- **el disco** — un archivo por blob, en
  `STORAGE_ROOT/{customer_id}/{sha[0:2]}/{sha[2:4]}/{blob_id}`.

**Deduplicación**: subir dos veces el mismo contenido guarda los bytes una sola
vez y crea dos filas lógicas (`deduplicated: true` en la respuesta). El alcance
es **por cliente**, nunca entre clientes.

**Sin versionado**: subir a una ruta ya ocupada la reemplaza (`replaced: true`).
La fila anterior queda como rastro auditado de qué había, pero no es una versión
recuperable: si su contenido se queda sin referencias, el recolector se lo lleva.

**Ciclo de una subida**: se escribe a `.tmp` calculando el hash al vuelo → se
reclama la fila del blob (o se reusa la que había) → `rename()` a su lugar
definitivo → recién ahí commitea la transacción. Si algo falla, no queda una fila
prometiendo bytes que no existen.

## Recolector

Cada ciclo (60 s por defecto):

1. **Temporales** — archivos en `.tmp` más viejos que `TMP_MAX_AGE_SEC`: subidas
   que murieron a mitad.
2. **Blobs huérfanos** — `reference_count = 0` desde hace más de `GC_GRACE_SEC`,
   tomados con `SKIP LOCKED`. Antes de borrar nada **recuenta contra
   `storage.files`**: si aparecen archivos vivos, corrige el contador y no borra.
   Si no, borra los bytes y marca la fila como `deleted`.

El servicio funciona sin él: sin recolector no se pierde nada, sólo se acumula
contenido sin referencias ocupando disco.

## Estructura

```
src/
├── config/     carga + validación de env (zod)
├── db/         pool pg + withAuditContext()
├── storage/    StorageProvider (interfaz) + LocalStorageProvider (disco)
├── auth/       api-key hardcodeada → {customer_id, app_id}
├── domain/     buckets (resolución + límites), upload (dedup + reemplazo),
│               files (consulta + borrado), normalize (saneo del borde), errors
├── api/        Fastify server, rutas, schemas zod, URLs firmadas, envío de contenido
├── worker/     gc + poller (60 s)
└── index.ts    arranque por flags (API y/o recolector)
```

## Migrar a otro proveedor de almacenamiento

Hoy corre **un proveedor por despliegue**: todo lo que se sube va al disco local.
Que convivan varios (una parte en disco, otra en S3) todavía no está
implementado — falta el resolver `backend → proveedor`. Pero el esquema y los
datos están preparados para que llegar ahí no obligue a reescribir nada.

**Por qué la migración es barata:**

- **La `storage_key` es agnóstica del backend.** `{customer_id}/{sha[0:2]}/{sha[2:4]}/{blob_id}`
  es a la vez una ruta de disco válida y una clave de objeto válida en S3 o
  Azure. El mismo contenido tiene **la misma clave en los dos lados**: migrar es
  copiar el árbol tal cual, sin recalcular ni remapear nada.
- **`blobs.backend` es por fila.** Una migración parcial es un `UPDATE` sobre las
  filas ya copiadas — un cliente, un rango de fechas, un 10% de prueba. No es un
  cambio de esquema ni una bandera global.
- **`blobs` está exenta de auditoría.** Un `UPDATE` masivo de millones de filas
  para cambiar el backend **no infla `audit.event_log`**.
- **Ni las FK ni la clave de deduplicación mencionan el backend.** Mover los
  bytes no toca `storage.files`: los archivos lógicos ni se enteran.

**Procedimiento — el orden importa:**

1. Implementar el proveedor contra `StorageProvider` y sumar su valor al enum:
   `ALTER TYPE storage.storage_backend ADD VALUE 's3';`
2. **Copiar los bytes primero.** Preservando las claves, sin tocar la base.
3. **Marcar las filas después**: `UPDATE storage.blobs SET backend = 's3' WHERE …`

   Nunca al revés. Si la fila dice `s3` y el objeto todavía no está, la descarga
   responde `410`. En este orden no hay ventana de error: un blob copiado pero
   aún marcado `local` se sigue sirviendo desde el disco sin que nadie lo note.
4. Borrar el contenido viejo recién cuando no quede ninguna fila apuntando al
   backend anterior.

**Durante la migración**, apagar el recolector (`WORKER_ENABLED=false`) hasta que
sepa resolver el proveedor por fila: hoy borra siempre contra el proveedor local.
El servicio funciona sin él — sin recolector no se pierde nada, sólo se acumula
contenido sin referencias.

**Si un backend futuro exigiera otro layout de clave** (límites de longitud, un
prefijo obligatorio), `storage_key` siendo una columna generada sería un
problema: cambiar la expresión recalcularía *todas* las filas, incluidas las que
siguen viviendo en la ruta vieja. La salida es un solo statement no destructivo,
en PostgreSQL 13+:

```sql
ALTER TABLE storage.blobs ALTER COLUMN storage_key DROP EXPRESSION;
```

Convierte la generada en columna normal **conservando los valores actuales**; a
partir de ahí cada fila puede tener el layout de su backend.

**Lo que queda por decidir el día que convivan dos proveedores**: dónde se elige
el destino de una subida nueva (lo natural es una columna `backend` en
`storage.buckets`), y si la deduplicación puede cruzar backends. Hoy la clave
única es `(customer_id, sha256)`, así que un bucket "de S3" podría terminar
apuntando a bytes en disco por dedup; si "los datos de este bucket están en S3"
tiene que ser cierto, la clave pasa a ser `(customer_id, sha256, backend)` y cada
backend deduplica dentro de sí mismo.

## Notas de diseño

- **El contenido nunca entra a la base.** Ni a las tablas ni, por lo tanto, a
  `audit.event_log`. Lo que sí queda auditado —y hay que tenerlo en cuenta— son
  los nombres, las rutas y el metadata.
- **Enlaces firmados sin estado**: HMAC sobre `id + vencimiento`, sin tabla de
  tokens. Verificar uno no toca la base. El precio es que no se revocan de a
  uno: para cortar todos se rota `DOWNLOAD_SIGNING_KEY`.
- **HTML y SVG se sirven siempre como descarga**, nunca en línea: mostrarlos en
  línea ejecutaría contenido de terceros en el origen del servicio (XSS
  almacenado). Además va `nosniff` y un CSP restrictivo en toda descarga.
- **Almacenamiento abstracto** vía `StorageProvider`. El proveedor local es el
  único implementado; S3 o Azure Blob entran contra la misma interfaz sin tocar
  el dominio — ver *Migrar a otro proveedor*. Dos detalles del contrato existen
  por ese futuro: `StagedContent.handle` es una referencia **opaca** (una ruta en
  disco acá, una clave temporal en un bucket allá), y `open()` resuelve
  existencia y lectura de una sola vez, porque preguntar primero cuesta un
  viaje de red por descarga contra un backend remoto.

## Límites conocidos

- **Sin `Range`**: las descargas se sirven completas. Reproducir un video largo
  con salto de posición todavía no funciona.
- **Cuota por suma**: se calcula sumando los archivos vigentes del bucket en cada
  subida (índice `idx_files_bucket_id` con `INCLUDE`, resuelto por index-only
  scan). Con buckets de muchísimos archivos conviene pasar a un contador
  denormalizado en su propia tabla.
- **Un archivo por petición**: subir varios de una es otra operación, con otro
  contrato de respuesta.
- **`STORAGE_ROOT` es local**: dos instancias de la API sólo pueden compartir
  contenido si comparten ese directorio (volumen de red, o un proveedor remoto).
