# Build the single self-contained binary, then ship it on slim Debian.
# The relay keeps all state in memory: run exactly one machine with
# autostop off (see fly.toml) — a restart wipes channels, tokens, and logs.
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY . .
RUN bun run build

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /app/team /app/team
EXPOSE 8787
# Admin token comes from the environment (fly secrets set TEAM_BUS_ADMIN_TOKEN=...).
# With no token set, bus-serve mints a random one and prints it once.
CMD ["/app/team", "bus-serve", "--port", "8787"]
