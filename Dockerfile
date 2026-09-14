FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 데이터 폴더는 컨테이너 사용자가 쓸 수 있어야 합니다.
RUN mkdir -p /data && chown -R node:node /app /data

# root 로 돌리지 않습니다. 프로세스가 뚫려도 컨테이너 내부 권한이 제한됩니다.
USER node

ENV HOST=0.0.0.0 PORT=5173 DATA_DIR=/data
VOLUME /data
EXPOSE 5173
CMD ["node", "server.js"]
