FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json server.js ./
RUN npm ci --omit=dev
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/daycraft.json
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
