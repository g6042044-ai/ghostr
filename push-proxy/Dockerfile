FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY server.js .
# Les fichiers de credentials (fcm-service-account.json, apns-key.p8)
# doivent être montés en volume ou injectés via secrets, jamais dans l'image.
EXPOSE 3200
USER node
CMD ["node", "server.js"]
