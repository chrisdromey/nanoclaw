/**
 * Thin wrapper around the TypeSafe SDK. One entry point for every Jev call in the watcher:
 * honours the JEV_ENABLED switch, pins the model, never throws (errors are logged and yield
 * null so callers fall back to current behaviour), and logs model/usage/latency per call.
 */
import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from '@typesafe-ai/sdk';
import { JEV_ENABLED, JEV_MODEL, TYPESAFE_API_KEY } from '../config.js';
import { logger } from '../logger.js';

let client: TypeSafeClient | null = null;

export function jevEnabled(): boolean {
  return JEV_ENABLED;
}

export async function askJev<const Q extends Questions>(
  state: EntryType,
  questions: Q,
  tag: string,
): Promise<SystemOneResult<Q> | null> {
  if (!jevEnabled()) return null;
  client ??= new TypeSafeClient({ apiKey: TYPESAFE_API_KEY, defaultModel: JEV_MODEL, logLevel: 'off', timeout: 15_000 });
  const started = Date.now();
  try {
    const res = await client.systemOne({ state, questions });
    logger.info(
      { tag, model: res.model, inputTokens: res.usage.input_tokens, ms: Date.now() - started, questions: Object.keys(questions) },
      'Jev call',
    );
    return res;
  } catch (err) {
    logger.error({ tag, err, ms: Date.now() - started }, 'Jev call failed');
    return null;
  }
}
