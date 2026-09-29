FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /app/apps/web
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm install --global npm@12.0.2 && npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/cubxxw/StripSearch" \
      org.opencontainers.image.revision=$REVISION
ENV NODE_ENV=production PORT=4392 STRIPSEARCH_HOST=127.0.0.1 STRIPSEARCH_DATA_DIR=/var/lib/stripsearch
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app/apps/web
COPY --from=build /app/apps/web/package.json ./package.json
COPY --from=build /app/apps/web/node_modules ./node_modules
COPY --from=build /app/apps/web/dist ./dist
RUN node -e 'require("fs").writeFileSync("dist/client/release.json", JSON.stringify({revision:process.argv[1]}))' "$REVISION"
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:"+process.env.PORT+"/api/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node", "dist/server/index.js"]
