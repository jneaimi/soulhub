/**
 * Model pricing — USD per 1,000,000 tokens.
 *
 * TODO: source real values from https://www.anthropic.com/pricing
 * Last updated: 2026-04-27 (PLACEHOLDER VALUES — do not trust dollars yet)
 *
 * When a model is missing from this map, cost calculations return null and the
 * UI displays `—` rather than $0.00.
 */

export interface ModelPricing {
	input: number;
	cacheCreate5m: number;
	cacheCreate1h: number;
	cacheRead: number;
	output: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
	// PLACEHOLDER — replace with current values from anthropic.com/pricing
	'claude-opus-4-7':   { input: 15, cacheCreate5m: 18.75, cacheCreate1h: 30, cacheRead: 1.5, output: 75 },
	'claude-opus-4-6':   { input: 15, cacheCreate5m: 18.75, cacheCreate1h: 30, cacheRead: 1.5, output: 75 },
	'claude-sonnet-4-6': { input: 3,  cacheCreate5m: 3.75,  cacheCreate1h: 6,  cacheRead: 0.3, output: 15 },
	'claude-haiku-4-5':  { input: 1,  cacheCreate5m: 1.25,  cacheCreate1h: 2,  cacheRead: 0.1, output: 5  },
};

/**
 * Resolve a model string (which may include a date suffix like
 * `claude-haiku-4-5-20251001`) to a pricing key. Returns null if unknown.
 */
function resolvePricing(model: string | undefined): ModelPricing | null {
	if (!model) return null;
	if (MODEL_PRICING[model]) return MODEL_PRICING[model];
	// Strip a trailing `-YYYYMMDD` date suffix if present
	const stripped = model.replace(/-\d{8}$/, '');
	if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];
	return null;
}

/**
 * Compute cost for a single message's usage. Returns null if pricing is unknown
 * (caller should display `—`, not zero).
 */
export function priceUsage(model: string | undefined, usage: {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
} | undefined): number | null {
	if (!model || !usage) return null;
	const p = resolvePricing(model);
	if (!p) return null;
	const input = usage.input_tokens ?? 0;
	const output = usage.output_tokens ?? 0;
	const cr = usage.cache_read_input_tokens ?? 0;
	// Prefer the breakdown if present, else fall back to the bulk cache_creation_input_tokens
	const cc5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
	const cc1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	const ccBulk = usage.cache_creation_input_tokens ?? 0;
	const ccBreakdown = cc5 + cc1;
	// If the breakdown adds up, trust it; otherwise treat the bulk number as 5m-rate
	const useBreakdown = ccBreakdown > 0 && Math.abs(ccBreakdown - ccBulk) <= ccBulk * 0.05;
	const ccCost = useBreakdown
		? (cc5 * p.cacheCreate5m + cc1 * p.cacheCreate1h)
		: (ccBulk * p.cacheCreate5m);
	return (input * p.input + output * p.output + cr * p.cacheRead + ccCost) / 1_000_000;
}
