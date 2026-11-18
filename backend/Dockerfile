
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY data ./data

RUN mkdir -p /app/storage \
    && chown -R node:node /app

ENV PORT=8080
ENV KLINE_DIR=/app/storage/klines
ENV INSTRUMENTS_CACHE=/app/storage/instruments.json

USER node

EXPOSE 8080

CMD ["npm", "start"]
