# Build from the repository root:  docker build -f apps/web/Dockerfile -t uo-crm-web .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @uo/shared --workspace @uo/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
# The /api rewrite target is fixed at build time. Give either the full origin, or just the API's
# private host:port (Render's Blueprint passes API_HOSTPORT) and http:// is added.
ARG API_HOSTPORT=api:4000
ARG API_ORIGIN=http://${API_HOSTPORT}
ENV API_ORIGIN=$API_ORIGIN
# Origin(s) of signed document links (your S3 bucket), allowed by the Content-Security-Policy.
ARG STORAGE_ORIGIN=https://*.amazonaws.com
ENV STORAGE_ORIGIN=$STORAGE_ORIGIN
RUN npm run build -w @uo/shared && npm run build -w @uo/web

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
