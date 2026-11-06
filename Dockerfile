# BlackCat Scyth3d. The runtime image downloads OrcaSlicer, which is AGPL-3.0.
# Distributing this image means offering corresponding source for both this
# service and OrcaSlicer to anyone who uses it over a network.

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    ORCA_SLICER_BIN=/opt/orcaslicer/bin/orca-slicer \
    ORCA_RESOURCES=/opt/orcaslicer/resources \
    SCYTH3D_DATA_DIR=/data \
    PORT=8080 \
    HOME=/tmp/scyth3d-home

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils xvfb \
      libegl1 libglu1-mesa libgstreamer-plugins-base1.0-0 \
      libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 \
      libmspack0 libopengl0 libwayland-server0 libgtk-3-0 \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/scyth3d-home /data

ARG NODE_VERSION=22.23.4
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version

ARG ORCA_VERSION=2.4.2
ARG ORCA_SHA256=d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd
RUN curl -fL -o /tmp/OrcaSlicer.AppImage \
      "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage" \
    && echo "${ORCA_SHA256}  /tmp/OrcaSlicer.AppImage" | sha256sum -c - \
    && chmod +x /tmp/OrcaSlicer.AppImage \
    && cd /opt && /tmp/OrcaSlicer.AppImage --appimage-extract \
    && mv /opt/squashfs-root /opt/orcaslicer \
    && rm /tmp/OrcaSlicer.AppImage \
    && chmod -R a+rX /opt/orcaslicer

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY profiles ./profiles

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin scyth3d \
    && chown -R scyth3d:scyth3d /app /data /tmp/scyth3d-home
USER scyth3d

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
