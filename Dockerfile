# One image for both targets: a Docker host (PGlite on a named volume, or Postgres)
# and Railway (Railway Postgres through DATABASE_URL). Only env vars differ.
FROM node:22-slim

RUN npm install -g pnpm@10.34.9 && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# Ponder compiles the TypeScript project at start, so dev dependencies (typescript,
# @types/node) stay in the image: install before NODE_ENV=production.
RUN pnpm install --frozen-lockfile

COPY . .
# A fresh id per build: a rebuilt image indexes into a fresh schema, a restarted
# container of the same image resumes from its stored checkpoint.
# Ponder writes ponder-env.d.ts, generated/ and .ponder/ at start: the app directory
# belongs to the unprivileged user it runs as. /data is the volume's mount point; a new
# named volume inherits this ownership.
RUN echo "b$(date +%s)" > .build-id \
  && mkdir -p /data /app/.ponder /app/generated \
  && chown -R node:node /app /data

ENV NODE_ENV=production \
    PORT=42069 \
    PGLITE_DIRECTORY=/data/pglite \
    PONDER_CACHE_BYTES=33554432 \
    NODE_OPTIONS="--max-old-space-size=192 --max-semi-space-size=4"

USER node
EXPOSE 42069
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "scripts/start.sh"]
