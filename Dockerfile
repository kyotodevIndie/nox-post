FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY tsconfig.json ./
RUN mkdir -p /data/media && chown node:node /data/media
ENV MEDIA_DIR=/data/media
USER node
EXPOSE 3500
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
