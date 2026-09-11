# ClickDown's container image. No source code goes in, or even reaches Docker: the build context is
# just the compiled binary and the built UI, which .github/workflows/package.yml builds beforehand.
# The binary is built with the container feature and listens on 0.0.0.0:4280 inside the container,
# so publish the port on the host's loopback only (-p 127.0.0.1:4280:4280, never --network host;
# on Linux, only Docker Engine 28.0+ keeps that off the network) and mount config.toml read-only;
# README.md, "Container image", has the command. There is no EXPOSE on purpose: with it,
# docker run -P would publish the port on every host interface.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 clickdown \
    && mkdir -p /opt/clickdown/ClickDown/logs && chown clickdown /opt/clickdown/ClickDown/logs
# The binary was built in /opt/clickdown/ClickDown, so it looks for config.toml there and for the UI in
# /opt/clickdown/ClickDown.Angular/dist/clickdown-angular/browser.
COPY browser /opt/clickdown/ClickDown.Angular/dist/clickdown-angular/browser
COPY clickdown /usr/local/bin/clickdown
USER clickdown
WORKDIR /opt/clickdown/ClickDown
# ClickDown stops cleanly on Ctrl+C; make `docker stop` send the same signal.
STOPSIGNAL SIGINT
ENTRYPOINT ["clickdown"]
