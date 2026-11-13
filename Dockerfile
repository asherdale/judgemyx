FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8788 DATA_DIR=/data
EXPOSE 8788
CMD ["node", "server.mjs"]
