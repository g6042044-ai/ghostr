# exit-relay/Dockerfile
# Image Docker pour Whisper Exit Relay
# Version 3.0

FROM node:20-alpine

# Métadonnées
LABEL maintainer="whisper"
LABEL version="3.0"
LABEL description="Whisper Exit Relay - Anonymous voice relay"

# Définir le répertoire de travail
WORKDIR /app

# Copier les fichiers de dépendances
COPY package.json ./

# Installer les dépendances (production only)
RUN npm install --production && npm cache clean --force

# Copier le code source
COPY server.js ./

# Exposer le port
EXPOSE 8080

# Utilisateur non-root pour la sécurité
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

# Variables d'environnement par défaut
ENV NODE_ENV=production
ENV PORT=8080

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Commande de démarrage
CMD ["node", "server.js"]