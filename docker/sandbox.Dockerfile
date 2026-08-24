# Company Brain sandbox: the agent runs here, never on the host.
# Contains pm (extraction CLI) + omp (reasoning) + duckdb (query). No secrets are baked in.

# ── pm ───────────────────────────────────────────────────────────────────────
# Built from source rather than copied from the host: the host binary is Mach-O
# (macOS) and cannot execute in a Linux container, and a bind-mounted artifact
# would make the image depend on someone having built it first. Building here
# means `brain sandbox build` produces a working sandbox on any machine.
#
# CGO is required — the go-duckdb driver fails to link with CGO_ENABLED=0
# ("undefined: Conn").
FROM golang:1.26-bookworm AS pm-build
ARG PM_REPO=https://github.com/polymetrics-ai/cli.git
ARG PM_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev git \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${PM_REF}" "${PM_REPO}" /src
WORKDIR /src
# -buildvcs=false: the checkout is shallow and Go's VCS stamping fails on it.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=1 go build -buildvcs=false -o /out/pm ./cmd/pm \
 && /out/pm --version || true

# ── runtime ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ARG TARGETARCH=arm64
ARG DUCKDB_VERSION=1.5.5

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bash git jq unzip ripgrep tini \
 && rm -rf /var/lib/apt/lists/*

# duckdb CLI — queries the warehouse Parquet in place
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) DUCK_ASSET="duckdb_cli-linux-arm64.zip" ;; \
      amd64) DUCK_ASSET="duckdb_cli-linux-amd64.zip" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/${DUCK_ASSET}"; \
    unzip -q /tmp/duckdb.zip -d /usr/local/bin; \
    rm /tmp/duckdb.zip; \
    duckdb -c "SELECT 'duckdb ok';"

# omp — the agent runtime (standalone binary, no Node/Bun needed)
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) OMP_ASSET="omp-linux-arm64" ;; \
      amd64) OMP_ASSET="omp-linux-x64" ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/omp \
      "https://github.com/can1357/oh-my-pi/releases/latest/download/${OMP_ASSET}"; \
    chmod +x /usr/local/bin/omp

# pm, from the builder stage. Present for inspection (connectors, catalog, connections
# list). Extraction still runs on the host: /warehouse is mounted read-only and pm's
# project state is single-writer, so a sync from inside a per-thread container would
# either fail or corrupt state under concurrency.
COPY --from=pm-build /out/pm /usr/local/bin/pm

RUN groupadd -g 10001 agent && useradd -u 10001 -g 10001 -m -s /bin/bash agent \
 && mkdir -p /workspace /brain /warehouse && chown -R 10001:10001 /workspace /home/agent

COPY entrypoint.sh /usr/local/bin/brain-entrypoint
RUN chmod +x /usr/local/bin/brain-entrypoint

USER 10001
# HOME lives on the per-workspace volume: the root filesystem is read-only, and omp needs a
# writable home for its cache and native addons.
ENV HOME=/workspace/home \
    PI_INSTALL_DIR=/workspace/home/.local/bin
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/brain-entrypoint"]
CMD ["sleep", "infinity"]
