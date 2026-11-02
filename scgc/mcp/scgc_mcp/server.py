"""scgc-mcp server — MCP tools for the SCGC gateway surface on the CoS fork.

Dependency-free (Python stdlib only), stdio transport. Dispatches to the
bundled helper scripts (scgc_mcp/helpers/) and talks to the CoS gateway.

Install (any machine) and register as a local MCP command:

    pipx install "git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"
    # or: pip install "scgc-mcp @ git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"

MCP config entry:

    {"type": "local", "command": ["scgc-mcp"]}

Security notes:
- Remote helpers take data as argv (validated), never interpolated into shell
  or Python source — an agent-supplied value cannot inject commands on the hub.
- The CoS gateway bearer key never leaves the hub: the authenticated request
  runs on the hub over SSH and only its response comes back.
- Sharing is scoped to the hub peer only (explicit device id).

Environment (all optional):
    SCGC_HUB_SSH        ssh target of the syncthing hub   (docker@<host>)
    SCGC_GATEWAY_URL    CoS gateway base url (local probes; models go via hub)
    SCGC_GATEWAY_KEY    bearer key, only used if SCGC_GATEWAY_URL is set to a
                        local/loopback gateway; default path keeps it on the hub.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

from . import __version__

HELPERS = pathlib.Path(__file__).resolve().parent / "helpers"
HUB = os.environ.get("SCGC_HUB_SSH", "docker@192.168.0.40")
GW_URL = os.environ.get("SCGC_GATEWAY_URL", "http://192.168.0.40:8793").rstrip("/")
GW_KEY = os.environ.get("SCGC_GATEWAY_KEY", "")
HUB_CFG = "/home/docker/.config/syncthing/config.xml"
FOLDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$")

TOOLS = [
    {
        "name": "syncthing_status",
        "description": "Report whether syncthing is running on this machine, its device ID, configured folders, and whether the hub is reachable over SSH.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "syncthing_join_hub",
        "description": "Self-service: join THIS machine to the syncthing hub. Installs/starts syncthing locally, registers the device on the hub over SSH, accepts the default cos-workspace folder, and verifies with a marker file. Idempotent and safe to retry.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "pattern": "^[A-Za-z0-9._-]{1,64}$", "description": "device label shown on the hub (default: hostname)"},
                "folder": {"type": "string", "description": "local folder to share (default: ~/cos-workspace)"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "syncthing_share_folder",
        "description": "Share an explicit local directory with the CoS container as a live bidirectional sync, scoped to the hub peer only. It appears under the container's /home/cos/shared/<slug>/.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "absolute local directory to share"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "syncthing_list_folders",
        "description": "List syncthing folders configured on this machine (id, label, path, shared device count).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "syncthing_unshare_folder",
        "description": "Remove a syncthing folder (by id) from this machine and from the hub.",
        "inputSchema": {
            "type": "object",
            "properties": {"folder_id": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$"}},
            "required": ["folder_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "cos_gateway_health",
        "description": "GET the CoS gateway /health endpoint on the hub; reports whether the in-app OpenAI gateway is up.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "cos_gateway_models",
        "description": "GET the CoS gateway /v1/models (bearer-authenticated on the hub; the key never leaves it). Returns models only after ChatGPT sign-in completes in the CoS setup.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


def run(cmd, timeout=120, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)


def local_cfg():
    for p in (pathlib.Path.home() / ".local/state/syncthing/config.xml",
              pathlib.Path.home() / ".config/syncthing/config.xml"):
        if p.exists():
            return p
    return None


def http_get(url, bearer=None):
    req = urllib.request.Request(url)
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode(errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="ignore")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def impl(name, args):
    if name == "syncthing_status":
        out = {"hub": HUB, "gateway_url": GW_URL}
        st = run(["systemctl", "--user", "is-active", "syncthing"]).stdout.strip()
        out["syncthing_running"] = st == "active"
        cfg = local_cfg()
        if cfg:
            import xml.etree.ElementTree as ET
            root = ET.parse(cfg).getroot()
            out["local_device_id"] = root.find("device").get("id")
            out["folders"] = [f.get("id") for f in root.findall("folder")]
        hub = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", HUB, "true"], timeout=15)
        out["hub_reachable"] = hub.returncode == 0
        return json.dumps(out)

    if name == "syncthing_join_hub":
        # explicit interpreter: wheel installs do not preserve script exec bits
        cmd = ["bash", str(HELPERS / "cos-sync-join.sh"), "--hub", HUB]
        if args.get("name"):
            cmd += ["--name", args["name"]]
        if args.get("folder"):
            cmd += ["--folder", args["folder"]]
        r = run(cmd, timeout=300)
        return _result(r)

    if name == "syncthing_share_folder":
        r = run(["bash", str(HELPERS / "cos-share.sh"), args["path"]], env={**os.environ, "SCGC_HUB_SSH": HUB}, timeout=180)
        return _result(r)

    if name == "syncthing_list_folders":
        cfg = local_cfg()
        if not cfg:
            return "no local syncthing config found"
        import xml.etree.ElementTree as ET
        root = ET.parse(cfg).getroot()
        rows = [{"id": f.get("id"), "label": f.get("label"), "path": f.get("path"),
                 "shared_with": len(f.findall("device"))} for f in root.findall("folder")]
        return json.dumps(rows)

    if name == "syncthing_unshare_folder":
        fid = args["folder_id"]
        if not FOLDER_ID.match(fid):
            raise ValueError(f"invalid folder_id: {fid!r}")
        cfg = local_cfg()
        if cfg:
            import xml.etree.ElementTree as ET
            root = ET.parse(cfg).getroot()
            for f in root.findall("folder"):
                if f.get("id") == fid:
                    root.remove(f)
            ET.ElementTree(root).write(cfg)
        run(["systemctl", "--user", "restart", "syncthing"], timeout=60)
        # remote helper takes the id as argv — never interpolated into source
        r = run(["scp", "-q", str(HELPERS / "st-removefolder.py"), f"{HUB}:/tmp/st-removefolder.py"], timeout=60)
        remote = run(["ssh", HUB, "python3 /tmp/st-removefolder.py " + HUB_CFG + " " + fid
                      + " && systemctl --user restart syncthing"], timeout=60)
        if r.returncode != 0 or remote.returncode != 0:
            raise RuntimeError(f"hub unshare failed: {remote.stderr.strip() or r.stderr.strip()}")
        return f"removed folder {fid}"

    if name == "cos_gateway_health":
        code, body = http_get(f"{GW_URL}/health")
        return f"HTTP {code}\n{body}"

    if name == "cos_gateway_models":
        if GW_KEY:  # explicit local/loopback gateway with a provided key
            code, body = http_get(f"{GW_URL}/v1/models", bearer=GW_KEY)
            return f"HTTP {code}\n{body}"
        # default: run the authenticated request ON the hub so the key never
        # crosses the network — only the response returns.
        cmd = ("KEY=$(grep '^GATEWAY_API_KEY=' ~/agent-proxy/simple-central-cos-gateway/gateway.env | cut -d= -f2-); "
               "curl -s -m 20 -H \"Authorization: Bearer $KEY\" http://127.0.0.1:8793/v1/models")
        r = run(["ssh", HUB, cmd], timeout=40)
        return r.stdout.strip() or f"hub request failed rc={r.returncode}: {r.stderr.strip()}"

    raise ValueError(f"unknown tool {name}")


def _result(r):
    text = (r.stdout + ("\n" + r.stderr if r.stderr else "")).strip()
    if r.returncode != 0:
        raise RuntimeError(text or f"command exited {r.returncode}")
    return text or "ok"


def handle(msg):
    if "method" not in msg:
        return None
    method = msg["method"]
    msg_id = msg.get("id")
    if method.startswith("notifications/"):
        return None
    if method == "ping":
        return {"id": msg_id, "result": {}}
    if method == "initialize":
        return {"id": msg_id, "result": {
            "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "scgc", "version": __version__},
        }}
    if method == "tools/list":
        return {"id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        p = msg.get("params", {})
        try:
            text = impl(p.get("name", ""), p.get("arguments") or {})
            return {"id": msg_id, "result": {"content": [{"type": "text", "text": text}], "isError": False}}
        except (ValueError, RuntimeError) as e:
            return {"id": msg_id, "result": {"content": [{"type": "text", "text": str(e)}], "isError": True}}
        except subprocess.TimeoutExpired:
            return {"id": msg_id, "result": {"content": [{"type": "text", "text": "operation timed out"}], "isError": True}}
        except Exception as e:  # noqa: BLE001
            return {"id": msg_id, "result": {"content": [{"type": "text", "text": f"error: {e}"}], "isError": True}}
    return {"id": msg_id, "result": {}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        resp = handle(msg)
        if resp is not None:
            # MCP responses must carry the JSON-RPC 2.0 envelope; strict
            # transports (e.g. OpenCode) reject and time out on responses
            # that omit it.
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", **resp}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
