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

FROM node:22-alpine3.23 AS build
WORKDIR /app

# Manifests first, so a change to source does not re-resolve the dependency tree.
#
# **The plugin's is not among them, and `npm ci` does not mind** (#324). The root manifest still
# declares four workspaces, and the belief here — and in `tools/pack.sh` — used to be that every
# member's manifest therefore had to be on disk. It does not: `npm ci` resolves the lockfile and
# skips a workspace whose directory is absent. What that belief cost is below, in `deps`.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY console/package.json console/
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
FROM node:22-alpine3.23 AS deps
WORKDIR /app
# **Without the plugin**, which is the whole of what this stage installs for nobody (#324).
# The server's cryptography is `@noble/hashes`; the plugin also declares `@noble/ciphers` and
# `@noble/curves`, workspace hoisting lands them in the root `node_modules`, and the runtime
# below copies that wholesale. So the image shipped a phone's cryptography to a process that
# never calls it — 2 MB of the 16 this stage produces.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY console/package.json console/
RUN npm ci --omit=dev
# npm workspaces HOIST: with no dev dependencies to force a conflict, everything lands in
# the root node_modules and the per-workspace ones are never created. The COPY below has
# to find something, and dropping it instead would silently lose any dependency npm does
# decide to nest later.
RUN mkdir -p server/node_modules shared/node_modules

# Every stage is pinned to an Alpine RELEASE, and this one has the sharpest reason: the package
# below. `postgresql18-client` exists in Alpine 3.23 and does not exist in 3.22, so a floating
# `node:22-alpine` builds today and stops building — or, worse, starts resolving a different
# major — on whichever Tuesday the tag moves.
#
# The build stages used to float, on the argument that only this one had a package to lose. They
# are pinned now for a duller reason (#324): a floating base means the compiler can change under
# a rebuild of an unchanged commit, and a release that cannot be rebuilt into the same bytes is
# a release nobody can check.
FROM node:22-alpine3.23 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `pg_dump` lives in the image because the backup runs from this process (docs/10), and its
# MAJOR VERSION MUST MATCH the server it dumps: pg_dump refuses a newer server outright, and
# an older one produces a dump that restores into something subtly different.
#
# Pinned to the major, deliberately, and it is the same 18 the compose file runs
# (`postgres:18-alpine`). Two numbers that must agree, in two files — so `assertPgDumpMatches`
# checks them at startup rather than trusting this line, and the image build in CI asserts the
# binary is here and is 18. An unpinned `postgresql-client` would follow the base image's
# repository to whatever major it carries next, which is exactly the drift the check exists to
# catch, discovered on a rebuild nobody connected to it.
RUN apk add --no-cache postgresql18-client

# A non-root default that suits a NAS, where services usually share one unprivileged uid
# and a common group: the blob volume must not end up owned by a user nobody else can write
# as. `RUN_AS` in .env overrides it per installation.
# Three directories, not one, and the defaults below point at them.
#
# `RESTORE_STATE_FILE` and `BACKUP_DESTINATION` used to keep the bare-`node` defaults
# (`var/...`, relative to the working directory), which in this image is /app and belongs to
# root while the process runs as 1001:100. So the image could not start on its own settings:
# it connected, applied the schema, and died on `mkdir 'var'` (issue #281). Every deployment
# sets both paths through compose, which is why nothing caught it until CI ran a container.
#
# `/data/backups` is a place that WORKS, not a place that is wise — backups beside the blobs
# they back up share a disk with them. The reference compose gives each its own mount, and an
# installation that means to keep copies should do the same.
RUN mkdir -p /data/blobs /data/state /data/backups && chown -R 1001:100 /data

COPY --from=deps  /app/node_modules      node_modules
COPY --from=deps  /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist        server/dist
# `server/src/console.ts` reads this at boot, relative to server/dist.
COPY --from=build /app/console/dist       console/dist
# `shared/` does NOT travel: it emits declarations and nothing else, and Node cannot load a
# `.d.ts`. Its `package.json` does, because that one IS read — by the resolver, if anything
# ever follows the workspace symlink in node_modules. Nothing does today, and this is checked
# rather than assumed: no emitted `.js` under server/dist or console/dist names the package,
# and the CI job that BUILDS this image also RUNS it.
COPY shared/package.json shared/
COPY server/package.json server/
COPY package.json ./
# The schema, because the server applies it now rather than the operator mounting it into the
# database container. An installation is a compose file and an `.env`; this is why it can be.
COPY server/db/schema.sql server/db/schema.sql

USER 1001:100
ENV HOST=0.0.0.0 PORT=8080 BLOB_STORE_PATH=/data/blobs
ENV RESTORE_STATE_FILE=/data/state/restore.epoch BACKUP_DESTINATION=/data/backups
EXPOSE 8080

# No wget, no curl in a slim Node image — so the check is Node, the one thing certainly
# present. It asks the API, not the port: a process that is listening but cannot reach
# PostgreSQL is not healthy, and a port check would call it so.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
