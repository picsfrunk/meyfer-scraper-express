# Dockerfile
FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Production port (not required if CLI only)
EXPOSE 8080

CMD ["node", "scraper.js"]
