FROM node:24.18.0-bookworm-slim AS build

WORKDIR /workspace
COPY . .

RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @devspace/gateway-caddy run build \
  && pnpm --filter @devspace/preview-gateway-host run build \
  && pnpm deploy --filter @devspace/preview-gateway-host --prod /runtime

FROM node:24.18.0-bookworm-slim

WORKDIR /app
COPY --from=build /runtime ./

USER node
CMD ["node", "dist/index.js"]
