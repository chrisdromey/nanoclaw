import { logger } from '../logger.js';
import { TOKEN_REFRESH_MS } from '../config.js';

let cachedToken = '';
let tokenExpiresAt = 0;

export async function getToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  try {
    const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    });

    if (!resp.ok) {
      logger.error({ status: resp.status }, 'eBay OAuth failed');
      return '';
    }

    const data = (await resp.json()) as { access_token?: string };
    cachedToken = data.access_token || '';
    tokenExpiresAt = Date.now() + TOKEN_REFRESH_MS;
    logger.info('eBay OAuth token refreshed');
    return cachedToken;
  } catch (err) {
    logger.error({ err }, 'eBay OAuth error');
    return '';
  }
}

export function invalidateToken(): void {
  cachedToken = '';
  tokenExpiresAt = 0;
}

export function isAuthError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('401');
}
