FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js keyTransparencyTree.js push-integration.js ./
RUN adduser -D ghostr
USER ghostr
EXPOSE 3100
ENV PORT=3100
CMD ["node", "server.js"]