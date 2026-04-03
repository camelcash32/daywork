FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p /var/data
EXPOSE 8080
CMD ["node", "server.js"]
