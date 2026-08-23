FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js ./server.js
COPY googleDriveMirror.js ./googleDriveMirror.js
COPY googleDriveMirrorContracts.js ./googleDriveMirrorContracts.js
COPY instagramProxy.js ./instagramProxy.js
COPY hermesProxy.js ./hermesProxy.js
COPY liveScreenBridge.js ./liveScreenBridge.js
COPY liveScreenRelay.js ./liveScreenRelay.js
COPY liveScreenSecurity.js ./liveScreenSecurity.js
COPY organizationHierarchy.js ./organizationHierarchy.js
COPY agentCalendarAccess.js ./agentCalendarAccess.js
COPY reservationIntegrations.js ./reservationIntegrations.js
COPY reservationSync ./reservationSync
COPY src/profileIds.js ./src/profileIds.js
RUN mkdir -p /data/chat-files /data/workspace /data/google-drive-assets /data/reservations \
    && chown -R node:node /app /data
USER node
EXPOSE 4173
CMD ["node", "server.js"]
