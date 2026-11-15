# The BFF serving the SPA too: the web application is built from its repository, at WEB_REF.
FROM oven/bun:1.4.4 AS web
ARG WEB_REPOSITORY=https://github.com/Soulware-Emergentes/web-application.git
ARG WEB_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /web
RUN git clone --depth 1 --branch "$WEB_REF" "$WEB_REPOSITORY" . \
    && bun install --frozen-lockfile \
    && bun run build

FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=web /web/dist/web-application/browser ./static
ENV STATIC_DIR=/app/static
USER bun
CMD ["bun", "run", "src/main.ts"]
