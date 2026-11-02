#!/usr/bin/env python3
"""Remove a syncthing folder from a config (argv-safe for remote use).

Usage: st-removefolder.py <config.xml> <folder_id>
"""
import re
import sys
import xml.etree.ElementTree as ET

FOLDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")

cfg_path, fid = sys.argv[1:3]
if not FOLDER_ID.match(fid):
    sys.exit(f"invalid folder id: {fid!r}")

tree = ET.parse(cfg_path)
root = tree.getroot()
removed = False
for f in root.findall("folder"):
    if f.get("id") == fid:
        root.remove(f)
        removed = True
tree.write(cfg_path)
print("removed" if removed else "not present", fid)
