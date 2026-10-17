# Build from the repository root:  docker build -f apps/api/Dockerfile -t uo-crm-api .
# The same image runs the API (default) or the background worker (`node dist/worker.js`).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @uo/shared --workspace @uo/api --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
# The seed is compiled too, so the first administrator can be created in production: npm run db:seed:prod
RUN npm run build -w @uo/shared && npm run build -w @uo/api && (cd apps/api && npx tsc -p tsconfig.seed.json) && npm prune --omit=dev --workspace @uo/shared --workspace @uo/api

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/dist-seed apps/api/dist-seed
COPY --from=build /app/apps/api/prisma apps/api/prisma
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
