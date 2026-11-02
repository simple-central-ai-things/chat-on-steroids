# scgc-mcp

Installable Python package (`scgc-mcp`, stdlib only) that exposes the
syncthing hub join/share helpers and the CoS OpenAI gateway controls as
MCP tools to any MCP-capable agent harness. The helper scripts ship inside
the package (`scgc_mcp/helpers/`) as package data.

Install (this directory of the fork is the canonical install source):

```sh
pipx install "git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"
uv tool install "git+https://github.com/simple-central-ai-things/chat-on-steroids.git@scgc/v2.1.49-gateway#subdirectory=scgc/mcp"
```

The install provides the `scgc-mcp` console script (also runnable as
`python3 -m scgc_mcp`). Publishing to the PyPI index is a one-step owner
action (`uv build && twine upload dist/*` with an API token).

Contracts, endpoints and the deploy docs live in `../README.md`.
