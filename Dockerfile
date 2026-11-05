FROM node:22-alpine
WORKDIR /app
COPY package.json server.js boards-api.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/circle.json
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
