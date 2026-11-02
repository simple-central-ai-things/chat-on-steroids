#!/usr/bin/env python3
"""Idempotently ensure a syncthing device exists in a config.

Usage: st-ensure-device.py <config.xml> <device_id> <device_name>
"""
import sys
import xml.etree.ElementTree as ET

cfg_path, dev_id, dev_name = sys.argv[1:4]
tree = ET.parse(cfg_path)
root = tree.getroot()

dev = root.find(f"device[@id='{dev_id}']")
if dev is None:
    dev = ET.SubElement(root, "device")
    dev.set("id", dev_id)
else:
    dev.set("name", dev_name)
dev.set("name", dev_name)
tree.write(cfg_path)
print("device ensured", dev_id)
