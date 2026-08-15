# syntax=docker/dockerfile:1

# ── Etapa 1: build ──────────────────────────────────────────────────────────
# node:24-slim (Debian/glibc): pg trae prebuilds nativos fiables; alpine (musl)
# obligaria a compilar desde fuente. pnpm via corepack para igualar el toolchain
# real: pnpm-lock.yaml es la fuente de verdad.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Store en /pnpm/store: coincide con el cache mount de abajo y, al estar en otro
# mount que node_modules, pnpm COPIA los paquetes a node_modules (autocontenido)
# en vez de hardlinkear -> se puede copiar tal cual a la imagen final.
ENV PNPM_STORE_DIR=/pnpm/store
RUN corepack enable
WORKDIR /app

# Dependencias con lockfile congelado (build reproducible). pnpm-workspace.yaml
# trae allowBuilds (esbuild) para que el install no falle por scripts ignorados.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Recorta a dependencias de produccion (fuera devDeps) para copiarlas tal cual.
RUN pnpm prune --prod

# ── Etapa 2: runtime ────────────────────────────────────────────────────────
FROM node:24-slim
# NODE_ENV=production: entorno productivo estandar (deshabilita dev tooling).
ENV NODE_ENV=production
WORKDIR /app

# tini como PID 1: reenvia SIGTERM (apagado ordenado del recolector + API) y
# cosecha zombies. El index.ts ya maneja SIGTERM/SIGINT para cerrar worker, API
# y pool.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Solo artefactos de runtime: node_modules ya podado + dist. Sin fuentes, sin
# devDependencies, sin scripts de administracion.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# EL CONTENIDO VIVE ACA. Se declara como volumen porque el filesystem de un
# contenedor es efimero: sin montar un volumen en /data, borrar el contenedor
# borra todos los archivos subidos aunque la base siga intacta — y quedaria una
# base entera de filas apuntando a bytes que ya no existen.
#   docker run -v storage_data:/data -e STORAGE_ROOT=/data ...
ENV STORAGE_ROOT=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# El servicio escucha en 0.0.0.0:3010 por defecto (config: PORT).
EXPOSE 3010
USER node

# Healthcheck de LIVENESS (/health): ¿responde el proceso? No apunta a la BD ni
# al disco para no reciclar el contenedor ante un blip — ese chequeo lo hace la
# probe del orquestador.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
