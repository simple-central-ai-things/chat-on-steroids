#!/usr/bin/env bash
# cos-share — sync an explicit local directory into the CoS container.
#
# The directory is added as a syncthing folder shared with the hub ONLY, on
# both sides; the hub copy lands under the container's /home/cos/shared/<slug>.
# Sync is bidirectional and continuous.
#
# Usage: cos-share.sh /path/to/directory
set -euo pipefail

DIR="${1:?usage: cos-share.sh /path/to/directory}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VM="${SCGC_HUB_SSH:-docker@192.168.0.40}"
VM_HUB_CFG="/home/docker/.config/syncthing/config.xml"
VM_SHARED_ROOT="/home/docker/agent-proxy/simple-central-cos-gateway/shared"

[ -d "$DIR" ] || { echo "not a directory: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
SLUG="$(basename "$DIR" | tr -c 'a-zA-Z0-9-' '-')"
# collision-resistant folder id: slug + hash of the absolute path
HASH="$(printf '%s' "$DIR" | sha256sum | cut -c1-6)"
FID="cos-${SLUG}-${HASH}"

LOCAL_CFG=""
for p in "$HOME/.local/state/syncthing/config.xml" "$HOME/.config/syncthing/config.xml"; do
  [ -f "$p" ] && { LOCAL_CFG="$p"; break; }
done
[ -n "$LOCAL_CFG" ] || { echo "no local syncthing config found" >&2; exit 3; }
LOCAL_ID="$(python3 -c "import xml.etree.ElementTree as ET; print(ET.parse('$LOCAL_CFG').getroot().find('device').get('id'))")"
VM_ID="$(ssh "$VM" "python3 -c \"import xml.etree.ElementTree as ET; print(ET.parse('$VM_HUB_CFG').getroot().find('device').get('id'))\"")"

scp -q "$HERE/st-addfolder.py" "$VM:/tmp/st-addfolder.py"

# local side
systemctl --user stop syncthing
python3 "$HERE/st-addfolder.py" "$LOCAL_CFG" "$FID" "$DIR" "$VM_ID"
systemctl --user start syncthing

# hub side (the folder lands under the container's /home/cos/shared/<slug>)
ssh "$VM" "mkdir -p '$VM_SHARED_ROOT/${SLUG}' && systemctl --user stop syncthing && \
  python3 /tmp/st-addfolder.py $VM_HUB_CFG $FID $VM_SHARED_ROOT/${SLUG} $LOCAL_ID && \
  systemctl --user start syncthing"

echo "sharing '$DIR' as folder '$FID' (peer: hub only) -> container path /home/cos/shared/${SLUG}"
