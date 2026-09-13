FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV HOST=0.0.0.0 PORT=5173 DATA_DIR=/data
VOLUME /data
EXPOSE 5173
CMD ["node", "server.js"]
