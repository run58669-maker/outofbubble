FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY server ./server
COPY web ./web
COPY fixtures ./fixtures
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
