#!/bin/bash
# Fetches a fresh eBay OAuth token and launches the eBay MCP server.
# Expects EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in the environment.
set -euo pipefail

if [ -z "${EBAY_CLIENT_ID:-}" ] || [ -z "${EBAY_CLIENT_SECRET:-}" ]; then
  echo "EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be set" >&2
  exit 1
fi

TOKEN=$(curl -sf https://api.ebay.com/identity/v1/oauth2/token \
  -u "${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}" \
  -d "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope" \
  | node -e "process.stdin.on('data',d=>{process.stdout.write(JSON.parse(d).access_token)})")

if [ -z "$TOKEN" ]; then
  echo "Failed to obtain eBay OAuth token" >&2
  exit 1
fi

export EBAY_CLIENT_TOKEN="$TOKEN"
export EBAY_API_ENV="production"
exec npx -y @ebay/npm-public-api-mcp@latest
