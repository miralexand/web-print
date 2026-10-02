FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/tmp /app/logs /app/data

EXPOSE 3000

CMD ["node", "src/app.js"]
