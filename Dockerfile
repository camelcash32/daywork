FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
