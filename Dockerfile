# ---------- Build stage ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev
# copy compiled code only
COPY --from=build /app/dist ./dist
# start compiled app
CMD ["npm", "run", "start"]
