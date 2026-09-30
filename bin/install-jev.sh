#!/usr/bin/env bash
# bin/install-jev.sh — Setup Jev semantic search and statusline cost monitor
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"

echo "==> Setting up Jev (System One) in Pi..."

# 1. Verify pi-mcp-adapter
if [ ! -d "${PI_DIR}/npm/node_modules/pi-mcp-adapter" ]; then
  echo "Installing pi-mcp-adapter..."
  pi install npm:pi-mcp-adapter
fi

# 2. Copy jev-cost extension
echo "Copying extensions/jev-cost.ts to ${PI_DIR}/extensions/jev-cost.ts..."
mkdir -p "${PI_DIR}/extensions"
cp -f "${ROOT_DIR}/extensions/jev-cost.ts" "${PI_DIR}/extensions/jev-cost.ts"

# 3. Configure statusline.json to allow jev-cost
STATUSLINE_CONF="${PI_DIR}/statusline.json"
if [ -f "${STATUSLINE_CONF}" ]; then
  echo "Ensuring 'jev-cost' is allowed in ${STATUSLINE_CONF}..."
  node -e "
    const fs = require('fs');
    try {
      const data = JSON.parse(fs.readFileSync('${STATUSLINE_CONF}', 'utf8'));
      if (Array.isArray(data.allowedKeys) && !data.allowedKeys.includes('jev-cost')) {
        data.allowedKeys.push('jev-cost');
      }
      fs.writeFileSync('${STATUSLINE_CONF}', JSON.stringify(data, null, 2) + '\n');
    } catch(e) {}
  "
fi

echo ""
echo "==> Jev installation complete!"
echo "Next step: Store your System One API key securely by running:"
echo "  ~/.pi/agent/npm/node_modules/.bin/pi-mcp-adapter key set systemone"
echo "Or configure interactively in Pi with:"
echo "  /mcp-adapter jev setup"
