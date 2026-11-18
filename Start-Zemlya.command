#!/bin/bash
cd "$(dirname "$0")" || exit 1
node_path="$(command -v node || true)"
bundled_node="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
if [ -z "$node_path" ] || ! "$node_path" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  node_path="$bundled_node"
fi
if [ ! -x "$node_path" ]; then
  printf '%s\n' 'Установи Node.js 24 и запусти файл ещё раз. https://nodejs.org/en/download'
  exit 1
fi
exec "$node_path" server.mjs
