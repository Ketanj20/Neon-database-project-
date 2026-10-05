FROM node:22-bookworm-slim

# pg_dump is provided by the PostgreSQL client package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# The app only needs this directory temporarily.
RUN mkdir -p /app/backups

EXPOSE 3000

CMD ["npm", "start"]
