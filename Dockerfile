FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY examples ./examples
COPY README.md ./README.md

ENV PORT=8080 \
    CONFIG_DIR=/config \
    TARGET_CONTAINER=airconnect

EXPOSE 8080

CMD ["npm", "start"]
