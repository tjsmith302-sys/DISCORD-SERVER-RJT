FROM node:20-slim

# Native deps for @discordjs/opus + voice
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
