# Install a pinned OpenClaw release from npm. Pinning keeps Railway deployments
# reproducible while avoiding a source checkout and its internal entry path.
FROM node:24-bookworm
ENV NODE_ENV=production
ARG OPENCLAW_VERSION=2026.9.5

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
    jq \
    gh \
    git \
    curl \
    ripgrep \
    less \
    procps \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# npm 11.16+ and npm 12 require explicit approval for OpenClaw's lifecycle
# scripts. Install before changing npm's global prefix to the /data volume.
RUN npm install --global --allow-scripts=openclaw "openclaw@${OPENCLAW_VERSION}" \
  && openclaw --version \
  && npm cache clean --force

# Persist user-installed npm tools by default by targeting the Railway volume.
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PATH="/data/npm/bin:${PATH}"

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# The wrapper listens on $PORT.
# IMPORTANT: Do not set a default PORT here.
# Railway injects PORT at runtime and routes traffic to that port.
# If we force a different port, deployments can come up but the domain will route elsewhere.
EXPOSE 8080

# Ensure PID 1 reaps zombies and forwards signals.
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
