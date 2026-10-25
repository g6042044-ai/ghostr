FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js cluster.js keyTransparencyTree.js push-integration.js blobSweep.js ./
RUN adduser -D ghostr && mkdir -p /data && chown ghostr:ghostr /data
USER ghostr
EXPOSE 3100
ENV PORT=3100
ENV KT_PERSIST_PATH=/data/kt_data
ENV CERT_PERSIST_PATH=/data/cert_state.json
ENV CHALLENGE_PERSIST_PATH=/data/challenges.json
# P1-B1: Persistance de la rotation 30j de la clé sealed sender.
# Sur Cloud Run, /data tombe dans /tmp éphémère → la rotation est perdue
# au cold start. Pour profiter pleinement de B1, faire A2 (cf docs/MIGRATION_PERSISTENCE.md)
# qui externalise /data vers un volume persistant (VPS, GCS Volume, ou GCE).
ENV SEALED_SENDER_PERSIST_PATH=/data/sealed_sender.json
# Cloud Run : utiliser server.js (Cloud Run scale horizontalement, pas besoin de cluster)
# VPS Docker : changer en "node cluster.js" pour multi-process sur un seul serveur
CMD ["node", "server.js"]
