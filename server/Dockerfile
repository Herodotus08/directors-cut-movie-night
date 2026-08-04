# Signalling rendezvous only — no media ever passes through this container, so a
# tiny instance is enough for a room of eight.
FROM node:20-alpine

WORKDIR /app

# Copy the manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Hosts inject their own PORT; 8080 is only the local default.
ENV NODE_ENV=production
EXPOSE 8080

# Don't run as root — a rendezvous point is internet-facing by definition.
USER node

CMD ["node", "server.js"]
