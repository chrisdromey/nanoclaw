/**
 * eBay source adapter for the dashboard.
 * Checks individual offer status via the eBay Browse API.
 */

import fs from 'fs';
import path from 'path';
import { NANOCLAW_ROOT } from '../config.js';
import type { StatusResult } from './index.js';

const EBAY_MARKETPLACE = 'EBAY_GB';
const ITEM_API_BASE = 'https://api.ebay.com/buy/browse/v1/item';
const TOKEN_TTL_MS = 5_400_000; // 90 min

function loadCredentials(): { clientId: string; clientSecret: string } {
  const envFile = path.join(NANOCLAW_ROOT, '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return { clientId: '', clientSecret: '' };
  }

  const vals: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vals[key] = value;
  }

  return {
    clientId: process.env.EBAY_CLIENT_ID || vals.EBAY_CLIENT_ID || '',
    clientSecret: process.env.EBAY_CLIENT_SECRET || vals.EBAY_CLIENT_SECRET || '',
  };
}

let cachedToken = '';
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const { clientId, clientSecret } = loadCredentials();
  if (!clientId || !clientSecret) return '';

  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!resp.ok) return '';

  const data = (await resp.json()) as { access_token?: string };
  cachedToken = data.access_token || '';
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

export async function checkOfferStatus(sourceId: string): Promise<StatusResult> {
  const token = await getToken();
  if (!token) return { status: 'active', error: 'No eBay token available' };

  const url = `${ITEM_API_BASE}/${encodeURIComponent(sourceId)}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE,
      'Content-Type': 'application/json',
    },
  });

  if (resp.status === 404) return { status: 'removed' };

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { status: 'active', error: `${resp.status}: ${body.slice(0, 200)}` };
  }

  const data = (await resp.json()) as { itemEndDate?: string };

  // eBay returns 200 for ended listings — check if itemEndDate is in the past
  if (data.itemEndDate && new Date(data.itemEndDate) < new Date()) {
    return { status: 'ended' };
  }

  return { status: 'active' };
}
