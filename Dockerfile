FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV PORT=8080
EXPOSE 8080
VOLUME /app/data
CMD ["node", "src/index.js"]
