# syntax=docker/dockerfile:1
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

FROM base AS build
# Each workspace owns its lockfile. Install only the packages used by this image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/core/package.json apps/core/pnpm-lock.yaml ./apps/core/
COPY packages/fs/package.json packages/fs/pnpm-lock.yaml ./packages/fs/
COPY packages/jit/package.json packages/jit/pnpm-lock.yaml ./packages/jit/
COPY packages/engine-host/package.json packages/engine-host/pnpm-lock.yaml ./packages/engine-host/
COPY packages/game-server/package.json packages/game-server/pnpm-lock.yaml ./packages/game-server/
RUN pnpm install --ignore-workspace --frozen-lockfile && \
    pnpm --filter noname... --filter @noname/engine-host --filter @noname/game-server install --frozen-lockfile
COPY . .
ENV NONAME_BUILD_SKIP_ASSETS=1
RUN pnpm build
# Keep runtime source, including engine sources, without duplicating the large asset trees.
RUN mkdir -p /runtime/apps/core /runtime/packages && \
    tar -C apps/core --exclude=./audio --exclude=./image --exclude=./node_modules --exclude=./dist --exclude=./dist-types -cf - . | tar -C /runtime/apps/core -xf -
RUN for package in engine-host game-server fs jit; do \
      mkdir -p /runtime/packages/$package; \
      tar -C packages/$package --exclude=./node_modules -cf - . | tar -C /runtime/packages/$package -xf -; \
    done

FROM base AS production-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/core/package.json apps/core/pnpm-lock.yaml ./apps/core/
COPY packages/fs/package.json packages/fs/pnpm-lock.yaml ./packages/fs/
COPY packages/jit/package.json packages/jit/pnpm-lock.yaml ./packages/jit/
COPY packages/engine-host/package.json packages/engine-host/pnpm-lock.yaml ./packages/engine-host/
COPY packages/game-server/package.json packages/game-server/pnpm-lock.yaml ./packages/game-server/
RUN pnpm install --ignore-workspace --prod --frozen-lockfile && \
    pnpm --filter noname... --filter @noname/engine-host --filter @noname/game-server install --prod --frozen-lockfile

FROM node:24-slim AS runtime
WORKDIR /app
# These large, rarely changed layers remain cached when source code changes.
COPY --chown=node:node apps/core/audio ./apps/core/audio
COPY --chown=node:node apps/core/image ./apps/core/image
COPY --from=production-deps --chown=node:node /app/ ./
COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /app/dist/ ./dist/
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 NONAME_DATA_DIR=/data NONAME_WEB_ROOT=/app/dist NONAME_ASSET_ROOTS=/app/apps/core
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'require("node:http").get("http://127.0.0.1:"+(process.env.PORT||8080)+"/healthz",r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on("error",()=>process.exit(1))'
CMD ["node", "--import", "/app/packages/engine-host/src/runtime/register.js", "/app/packages/game-server/src/main.ts"]
