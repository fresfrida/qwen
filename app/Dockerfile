# Pinned minor tag; replace with a digest-pinned tag (npm run digests) before wide deploy.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# dependency layer first, prod only, lockfile enforced
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# app code; config fails closed if MODE/OWNER_* are wrong, so a bad deploy stops at boot
COPY src ./src
COPY public ./public

# the container runs read-only except /data, as a non-root user
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
ENV PORT=3000 DATA_DIR=/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
