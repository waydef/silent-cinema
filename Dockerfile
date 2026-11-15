FROM node:26-alpine

# ffmpeg brings ffprobe; busybox already has nice
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js stream.js ./
COPY public ./public

# inside the container the host listener has to bind every interface, so that the port mapping
# can reach it; publish it on the docker host's loopback only (see compose.yaml)
ENV NODE_ENV=production \
    PORT=8080 \
    HOST_PORT=8088 \
    HOST_BIND=0.0.0.0 \
    PICKER=library \
    MEDIA_DIR=/media \
    STATE_DIR=/data/state \
    CACHE_DIR=/data/cache

RUN mkdir -p /data /media && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8088

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${HOST_PORT}/robots.txt" || exit 1

CMD ["node", "server.js"]
