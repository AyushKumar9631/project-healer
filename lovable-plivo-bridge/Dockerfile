FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install --no-save tsx
COPY . .
EXPOSE 8080
CMD ["npx", "tsx", "server.ts"]
