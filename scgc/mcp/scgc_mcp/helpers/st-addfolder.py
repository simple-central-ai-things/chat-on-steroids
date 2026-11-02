#!/usr/bin/env python3
"""Add (idempotently) a syncthing folder shared with EXPLICIT peer devices.

Usage: st-addfolder.py <config.xml> <folder_id> <folder_path> <peer_device_id> [<peer_device_id> ...]

Sharing is scoped to the listed peers only — never "all configured devices" —
so a mis-targeted share cannot expose the folder to unrelated peers.
"""
import re
import sys
import xml.etree.ElementTree as ET

FOLDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")
DEV_ID = re.compile(r"^[A-Z0-9-]{52}$")

cfg_path, fid, fpath = sys.argv[1:4]
peers = sys.argv[4:]
if not FOLDER_ID.match(fid):
    sys.exit(f"invalid folder id: {fid!r}")
for d in peers:
    if not DEV_ID.match(d):
        sys.exit(f"invalid device id: {d!r}")

tree = ET.parse(cfg_path)
root = tree.getroot()
self_id = root.find("device").get("id")

for f in root.findall("folder"):
    if f.get("id") == fid:
        root.remove(f)

folder = ET.SubElement(root, "folder")
folder.set("id", fid)
folder.set("label", fid)
folder.set("path", fpath)
folder.set("rescanIntervalS", "60")  # 60s fallback: Docker bind-mount writes miss inotify
for dev_id in [self_id, *peers]:
    fd = ET.SubElement(folder, "device")
    fd.set("id", dev_id)

tree.write(cfg_path)
print("added folder", fid, "shared with", len(peers), "peer(s)")
