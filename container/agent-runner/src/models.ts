/**
 * Explicit model pins. Never rely on the SDK/CLI default or aliases (sonnet/haiku), which move
 * when the SDK is bumped. Override the main/evaluator model with NANOCLAW_MODEL.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const MODEL = process.env.NANOCLAW_MODEL || DEFAULT_MODEL;
/** Evaluators and research sub-agents: same as the main model unless overridden. */
export const EVALUATOR_MODEL = process.env.NANOCLAW_EVALUATOR_MODEL || MODEL;
