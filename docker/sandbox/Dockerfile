# companion-sandbox
#
# Minimal execution environment for run_shell and run_tests.
# This image is launched per-command by SandboxExecutor with:
#   --rm              container removed immediately after exit
#   --network=none    no outbound network (overridden by sandbox.network in config)
#   --volume=...      working directory mounted at /workspace
#   --workdir=/workspace
#
# Build:
#   docker build -t companion-sandbox:latest docker/sandbox/
#   podman build -t companion-sandbox:latest docker/sandbox/
#   nerdctl build -t companion-sandbox:latest docker/sandbox/
#
# The image intentionally installs more than strictly necessary so that agents
# can run common diagnostic and development commands without surprises.
# It is NOT a general-purpose dev environment — keep it lean.

FROM alpine:3.21

# --- Core shell tooling ---
# bash         explicit bash (agents may use bash-isms)
# coreutils    GNU coreutils: uptime, sort, head, tail, cut, wc, etc.
# util-linux   column, lsblk, hexdump, etc.
# procps       ps, top, free, watch (BSD ps in Alpine busybox is limited)
# shadow       useradd / usermod for the non-root user below
RUN apk add --no-cache \
    bash \
    coreutils \
    util-linux \
    procps \
    shadow \
    \
    # --- Filesystem / search ---
    findutils \
    grep \
    sed \
    gawk \
    file \
    tree \
    \
    # --- Network diagnostics (read-only; network=none at runtime anyway) ---
    curl \
    wget \
    bind-tools \
    \
    # --- Development runtimes ---
    python3 \
    py3-pip \
    sqlite \
    git \
    jq \
    \
    # --- Archive tools ---
    tar \
    gzip \
    unzip \
    \
    # --- Text processing ---
    less \
    diffutils \
    patch

# --- Non-root user ---
# Run as uid 1000 (commonly mapped to the host user).
# The working directory /workspace is mounted rw by the caller.
RUN adduser -D -u 1000 -s /bin/bash sandbox

# --- Workspace ---
RUN mkdir -p /workspace && chown sandbox:sandbox /workspace

# --- Default shell ---
# Use bash explicitly so skill scripts that source .bashrc work correctly.
ENV SHELL=/bin/bash

USER sandbox
WORKDIR /workspace

# Default entrypoint — overridden by SandboxExecutor with:
#   sh -c "<command>"
CMD ["/bin/bash"]
