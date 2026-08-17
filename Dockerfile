# syntax=docker/dockerfile:1
#
# Build this ON the machine that will run it, or FOR that machine's platform. A NAS is
# usually x86-64 while a laptop may be ARM, and an image built for the wrong one starts and
# immediately dies with an exec format error that says nothing about why:
#
#     docker buildx build --platform linux/amd64 -t syncserver:dev .
#
# Building where it runs needs no flag, which is why the deployment copies source rather
# than an image.

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so a change to source does not re-resolve the dependency tree.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY console/package.json console/
COPY plugin/package.json plugin/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
RUN npm run build -w @syncserver/server

# The console is part of this image because the server serves it from its own process
# (docs/11: one deployment, one session). Built here rather than shipped as a second
# artefact: one thing to deploy, one version, and no way for the two to disagree.
COPY console/ console/
RUN npm run build -w @syncserver/console

# The runtime tree is installed separately rather than pruned out of the build one: a
# prune leaves whatever the build happened not to touch, an install brings exactly what
# the manifests declare.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY console/package.json console/
COPY plugin/package.json plugin/
RUN npm ci --omit=dev
# npm workspaces HOIST: with no dev dependencies to force a conflict, everything lands in
# the root node_modules and the per-workspace ones are never created. The COPY below has
# to find something, and dropping it instead would silently lose any dependency npm does
# decide to nest later.
RUN mkdir -p server/node_modules shared/node_modules

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# A non-root default that suits a NAS, where services usually share one unprivileged uid
# and a common group: the blob volume must not end up owned by a user nobody else can write
# as. `RUN_AS` in .env overrides it per installation.
RUN mkdir -p /data/blobs && chown -R 1001:100 /data

COPY --from=deps  /app/node_modules      node_modules
COPY --from=deps  /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist        server/dist
COPY --from=build /app/shared/dist        shared/dist
# `server/src/console.ts` reads this at boot, relative to server/dist.
COPY --from=build /app/console/dist       console/dist
COPY shared/package.json shared/
COPY server/package.json server/
COPY package.json ./

USER 1001:100
ENV HOST=0.0.0.0 PORT=8080 BLOB_STORE_PATH=/data/blobs
EXPOSE 8080

# No wget, no curl in a slim Node image — so the check is Node, the one thing certainly
# present. It asks the API, not the port: a process that is listening but cannot reach
# PostgreSQL is not healthy, and a port check would call it so.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
