# Debian slim, not Alpine: the local embedding model runs on onnxruntime-node,
# whose native binaries need glibc.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Downloaded embedding models are cached here (a named volume in Compose).
RUN mkdir -p /models && chown node:node /models
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
