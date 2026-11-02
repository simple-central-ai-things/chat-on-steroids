# SCGC — Chat On Steroids with the OpenAI-compatible gateway compiled in.
#
# Builds THIS repo (the fork) from source on the scgc/* gateway branch and
# ships a VNC-served desktop where the gateway answers on 8793 inside the
# app process. Self-referential by design: the deploy surface lives beside
# the code it builds, so an upgrade is one branch, not two repos.
# The branch carries the whole delta as commits: src/main/openai-gateway/
# (the module) plus its bootstrap wiring in src/main/index.ts. Upgrading is a
# deliberate step: cut a new scgc/<tag>-gateway branch from the new upstream
# tag carrying the same delta, then bump COS_BRANCH here.
#
# debian:trixie on purpose: the tree-sitter prebuilt binary needs
# GLIBCXX_3.4.31, which Ubuntu 22.04's libstdc++ does not provide.
#
# The build context (base packages, building as the non-root `cos` user, CoS
# at /home/cos/chat-on-steroids) matches the known-good reference build:
# Electron traps at startup in a few slightly different rootfs configurations,
# so do not change the environment casually without re-testing the app launch.

FROM debian:trixie

ARG COS_BRANCH=scgc/v2.1.49-gateway
ARG COS_REPO=https://github.com/simple-central-ai-things/chat-on-steroids.git

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git unzip \
        nodejs npm python3 make g++ \
        tigervnc-standalone-server openbox dbus-x11 gnome-keyring xauth \
        libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 \
        libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
        libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 \
        libxrandr2 libxfixes3 libxcursor1 libxi6 libpango-1.0-0 libcairo2 \
        fonts-liberation x11-utils firefox-esr \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 -d /home/cos cos \
    && mkdir -p /home/cos/.config/tigervnc /home/cos/cos-logs \
    && chown -R cos:cos /home/cos

USER cos
WORKDIR /home/cos/chat-on-steroids

# Our fork at the gateway branch: the module and the bootstrap wiring are
# already committed there, so no in-build patching. A missing branch or a
# moved upstream entry point fails here or at typecheck/build time.
RUN git clone --depth 1 --branch ${COS_BRANCH} ${COS_REPO} . \
    && test -f src/main/openai-gateway/openai-server.ts \
    && test -f test/scgc-gateway/tsconfig.json \
    && npm ci --no-audit --no-fund \
    && node node_modules/electron/install.js \
    && test -x node_modules/electron/dist/electron \
    && npm run build \
    && npm cache clean --force

# CoS' npm flow skips electron's postinstall binary download; install.js makes
# it explicit and the test fails the build loudly if the binary is ever absent.

# CoS needs the OpenAI tunnel-client binary for its Setup "Connect the tunnel"
# step. CoS pins it by version + SHA-256 in scripts/packaging-versions.mjs and
# stages the verified binary into resources/tunnel/ (the locator's bundled
# location, checked before PATH). `npm run tunnel` runs that exact fetch.
# xstartup launches the app DIRECTORY (`electron .`), so app.getAppPath() is
# the repo root and resources/tunnel/ is found at runtime.
RUN npm run tunnel \
    && test -x resources/tunnel/tunnel-client

COPY --chown=cos:cos scgc/xstartup /home/cos/.config/tigervnc/xstartup
COPY --chown=cos:cos scgc/entrypoint.sh /entrypoint.sh
COPY --chown=cos:cos scgc/browser-watch.sh /home/cos/browser-watch.sh
RUN chmod +x /home/cos/.config/tigervnc/xstartup /entrypoint.sh

# 5901: VNC display :1. 8793: the OpenAI-compatible gateway inside the app.
EXPOSE 5901 8793

# entrypoint starts Xvnc, then runs xstartup as PID 1 (see entrypoint.sh for
# why CMD must not be `vncserver` directly).
CMD ["sh", "/entrypoint.sh"]
