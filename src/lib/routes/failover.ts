import type { ChatRequest, ChatResult, ProviderRef } from '../llm/types.js';
import { getChatProvider } from '../llm/registry.js';
import { parseProviderRef } from '../llm/types.js';
import * as breaker from './circuit-breaker.js';
import {
	AllProvidersFailedError,
	ProviderUnavailableError,
	UnsupportedProviderError,
} from './errors.js';
import type { AttemptRecord, FailoverTrigger, RouteConfig } from './types.js';

/** Categorise an error as a failover trigger, when one applies. Returns
 *  `null` for errors that should NOT trigger failover (4xx, content
 *  policy, programmer error). */
export function classifyError(err: unknown): FailoverTrigger | null {
	if (err instanceof UnsupportedProviderError || err instanceof ProviderUnavailableError) {
		return 'network'; // treat as network-class so users can opt out via onError
	}
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		const status = (err as { status?: number; statusCode?: number; response?: { status?: number } })
			.status
			?? (err as { statusCode?: number }).statusCode
			?? (err as { response?: { status?: number } }).response?.status;

		// Abort errors from our timeout watchdog — fall back as a timeout.
		if (err.name === 'AbortError' || msg.includes('aborted')) return 'timeout';

		if (typeof status === 'number') {
			if (status === 429) return 'rate_limit';
			if (status >= 500) return '5xx';
			if (status >= 400) return null; // user error
		}

		// Network-class signals from undici/node-fetch.
		if (
			msg.includes('econnreset') ||
			msg.includes('enotfound') ||
			msg.includes('etimedout') ||
			msg.includes('econnrefused') ||
			msg.includes('fetch failed') ||
			msg.includes('network')
		) {
			return 'network';
		}
	}
	return null;
}

/** True when the error class is in the route's `onError` allow-list. */
export function shouldFailover(err: unknown, triggers: FailoverTrigger[]): boolean {
	const trigger = classifyError(err);
	if (!trigger) return false;
	return triggers.includes(trigger);
}

/** Run a single provider with a bounded timeout. The caller's signal (if
 *  any) is forwarded — aborting it cancels both the timer and the upstream. */
async function callWithTimeout(
	ref: ProviderRef,
	request: ChatRequest,
	timeoutMs: number,
): Promise<ChatResult> {
	const { providerId, modelId } = parseProviderRef(ref);

	if (providerId === 'cli') {
		throw new UnsupportedProviderError(
			`CLI chat dispatch is deferred to Phase 4 (WhatsApp adapter). Configure a non-CLI provider for "${ref}" or remove it from the route's chain.`,
		);
	}

	const provider = getChatProvider(providerId);
	if (!provider.available()) {
		throw new ProviderUnavailableError(
			providerId,
			`Provider "${providerId}" has no credential set (env: ${provider.envKey}).`,
		);
	}

	const controller = new AbortController();
	const userSignal = request.signal;
	const onUserAbort = () => controller.abort();
	if (userSignal) {
		if (userSignal.aborted) controller.abort();
		else userSignal.addEventListener('abort', onUserAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await provider.generate({
			...request,
			model: modelId,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
	}
}

async function callRefWithRetry(
	ref: ProviderRef,
	request: ChatRequest,
	route: RouteConfig,
): Promise<ChatResult> {
	let lastError: Error | undefined;
	const maxAttempts = route.retries + 1;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await callWithTimeout(ref, request, route.timeoutMs);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			// Non-retryable error — bubble immediately so the outer loop can
			// decide whether to failover (it won't, for the same classification).
			if (!shouldFailover(err, route.onError)) throw lastError;
			// else: retry until attempts exhausted, then bubble.
		}
	}

	throw lastError ?? new Error('exhausted retries with no captured error');
}

/** Execute `request` against the route's provider chain. Honours retries,
 *  per-attempt timeout, the failover allow-list, and the circuit breaker. */
export async function executeWithFailover(
	route: RouteConfig,
	request: ChatRequest,
): Promise<{ result: ChatResult; chain: ProviderRef[]; attempts: AttemptRecord[]; answeredBy: ProviderRef }> {
	const chain: ProviderRef[] = [route.default, ...route.failover];
	const attempts: AttemptRecord[] = [];
	let lastError: Error | undefined;

	for (const ref of chain) {
		const start = Date.now();

		if (breaker.isOpen(ref)) {
			attempts.push({ ref, status: 'circuit-open', durationMs: 0 });
			continue;
		}

		try {
			const result = await callRefWithRetry(ref, request, route);
			attempts.push({ ref, status: 'ok', durationMs: Date.now() - start });
			breaker.recordSuccess(ref);
			return { result, chain, attempts, answeredBy: ref };
		} catch (err) {
			const durationMs = Date.now() - start;
			const error = err instanceof Error ? err : new Error(String(err));
			lastError = error;

			if (err instanceof ProviderUnavailableError || err instanceof UnsupportedProviderError) {
				attempts.push({ ref, status: 'unavailable', error: error.message, durationMs });
				continue;
			}

			if (shouldFailover(err, route.onError)) {
				attempts.push({ ref, status: 'failed-retryable', error: error.message, durationMs });
				breaker.recordFailure(ref);
				continue;
			}

			attempts.push({ ref, status: 'failed-fatal', error: error.message, durationMs });
			throw error; // 4xx and similar — not the next provider's problem.
		}
	}

	throw new AllProvidersFailedError(chain, lastError);
}
