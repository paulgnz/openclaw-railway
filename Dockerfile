# Install openclaw from npm (always latest) instead of building from source.
# This keeps models, providers, and features up-to-date automatically.
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*

# Install openclaw globally (same approach as official railway template)
RUN npm install -g openclaw@latest

# pnpm for plugin management
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Cache-bust: increment to force src re-copy
ARG SRC_VERSION=5
COPY src ./src

# The wrapper listens on $PORT.
# IMPORTANT: Do not set a default PORT here.
# Railway injects PORT at runtime and routes traffic to that port.
# If we force a different port, deployments can come up but the domain will route elsewhere.
EXPOSE 3000
CMD ["node", "src/server.js"]
