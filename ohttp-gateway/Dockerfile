FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js cluster.js keyTransparencyTree.js push-integration.js ./
RUN adduser -D ghostr && mkdir -p /data && chown ghostr:ghostr /data
USER ghostr
EXPOSE 3100
ENV PORT=3100
ENV KT_PERSIST_PATH=/data/kt_data
ENV CERT_PERSIST_PATH=/data/cert_state.json
ENV CHALLENGE_PERSIST_PATH=/data/challenges.json
# Cloud Run : utiliser server.js (Cloud Run scale horizontalement, pas besoin de cluster)
# VPS Docker : changer en "node cluster.js" pour multi-process sur un seul serveur
CMD ["node", "server.js"]