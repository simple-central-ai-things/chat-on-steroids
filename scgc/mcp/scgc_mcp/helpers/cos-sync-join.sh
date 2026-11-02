#!/usr/bin/env bash
# cos-sync-join — self-service: join THIS machine to the syncthing hub.
#
# Ensures syncthing runs locally, registers this device on the hub (over SSH —
# the hub API password never leaves the hub), accepts the default folder
# locally, and verifies. Safe to retry; idempotent.
#
# Usage: cos-sync-join.sh [--hub <ssh-target>] [--name <label>] [--folder <local-path>]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

HUB="${SCGC_HUB_SSH:-docker@192.168.0.40}"
NAME="$(hostname 2>/dev/null || echo host)"
FOLDER="$HOME/cos-workspace"
HUB_CFG="/home/docker/.config/syncthing/config.xml"
HUB_FOLDER="/home/docker/agent-proxy/simple-central-cos-gateway/workspace"

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --folder) FOLDER="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
# labels go into XML attributes and remote argv — keep them strict
case "$NAME" in
  *[!A-Za-z0-9._-]*|"") echo "invalid device name: $NAME" >&2; exit 2 ;;
esac
FOLDER="$(mkdir -p "$FOLDER" && cd "$FOLDER" && pwd)"

SYNCTHING="$HOME/.local/bin/syncthing"
command -v syncthing >/dev/null 2>&1 && SYNCTHING="$(command -v syncthing)"

# 1) ensure syncthing installed + running locally
if [ ! -x "$SYNCTHING" ]; then
  echo "installing syncthing to ~/.local/bin"
  mkdir -p "$HOME/.local/bin"
  V="$(curl -s "https://api.github.com/repos/syncthing/syncthing/tags?per_page=100" \
    | python3 -c "import json,sys; print([t['name'] for t in json.load(sys.stdin) if t['name'].startswith('v1.')][0])")"
  curl -sSL -o "$HOME/.cache/opencode/tmp/st.tar.gz" \
    "https://github.com/syncthing/syncthing/releases/download/$V/syncthing-linux-amd64-$V.tar.gz"
  tar xzf "$HOME/.cache/opencode/tmp/st.tar.gz" -C "$HOME/.cache/opencode/tmp"
  cp "$HOME/.cache/opencode/tmp"/syncthing-linux*/syncthing "$SYNCTHING" && chmod +x "$SYNCTHING"
fi
if [ ! -f "$HOME/.config/systemd/user/syncthing.service" ]; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/syncthing.service" <<EOF
[Unit]
Description=Syncthing folder sync (simple-central)
After=network-online.target
[Service]
ExecStart=$SYNCTHING serve --no-browser --no-restart
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
fi
systemctl --user enable --now syncthing

# config dir varies by version; test each path individually (no pipefail+ls)
LOCAL_CFG=""
for i in $(seq 1 15); do
  for p in "$HOME/.local/state/syncthing/config.xml" "$HOME/.config/syncthing/config.xml"; do
    [ -f "$p" ] && { LOCAL_CFG="$p"; break 2; }
  done
  sleep 2
done
[ -n "$LOCAL_CFG" ] || { echo "local syncthing config never appeared" >&2; exit 1; }

LOCAL_ID="$(python3 -c "import xml.etree.ElementTree as ET; print(ET.parse('$LOCAL_CFG').getroot().find('device').get('id'))")"
HUB_ID="$(ssh "$HUB" "python3 -c \"import xml.etree.ElementTree as ET; print(ET.parse('$HUB_CFG').getroot().find('device').get('id'))\"")"

# leave syncthing running on both sides even if wiring fails mid-flight
cleanup() { systemctl --user start syncthing >/dev/null 2>&1 || true; }
trap cleanup EXIT

scp -q "$HERE/st-ensure-device.py" "$HERE/st-addfolder.py" "$HUB:/tmp/"

# 2) wire both sides (stop, edit, start) — idempotent helpers, explicit peers
systemctl --user stop syncthing
python3 "$HERE/st-ensure-device.py" "$LOCAL_CFG" "$HUB_ID" "$HUB"
python3 "$HERE/st-addfolder.py" "$LOCAL_CFG" cos-workspace "$FOLDER" "$HUB_ID"
systemctl --user start syncthing

ssh "$HUB" "systemctl --user stop syncthing && \
  python3 /tmp/st-ensure-device.py $HUB_CFG $LOCAL_ID '$NAME' && \
  python3 /tmp/st-addfolder.py $HUB_CFG cos-workspace $HUB_FOLDER $LOCAL_ID && \
  systemctl --user start syncthing"

# 3) verify the sync end to end with a marker file — catches firewall / NAT /
# relay problems that wiring alone cannot see. The marker is left in the
# synced folder (a hidden dotfile) as a join artifact.
MARKER=".cos-join-check-$(date +%s)"
printf 'device %s (%s) joined %s\n' "$LOCAL_ID" "$NAME" "$MARKER" > "$FOLDER/$MARKER"
SYNCED=0
for i in $(seq 1 30); do
  if ssh -o BatchMode=yes -o ConnectTimeout=6 "$HUB" "test -f '$HUB_FOLDER/$MARKER'"; then
    SYNCED=1
    break
  fi
  sleep 3
done

trap - EXIT
echo "joined hub as '$NAME' (device $LOCAL_ID)"
echo "local folder $FOLDER <-> hub $HUB_FOLDER -> container /home/cos/workspace"
if [ "$SYNCED" -eq 1 ]; then
  echo "sync verified: marker $MARKER reached the hub"
else
  echo "warning: marker did not reach the hub within 90s — wiring is in place, sync may still be pending (check firewall, NAT, relay)" >&2
  exit 1
fi
