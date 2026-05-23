/** Public surface for the routes layer. */

export { dispatchRoute } from './dispatcher.js';
export { getRoute, hasRoute, listRoutes, listRouteNames } from './registry.js';
export { executeWithFailover, classifyError, shouldFailover } from './failover.js';
export {
	UnsupportedProviderError,
	ProviderUnavailableError,
	RouteNotFoundError,
	AllProvidersFailedError,
} from './errors.js';
export * as circuitBreaker from './circuit-breaker.js';
export type {
	RouteConfig,
	FailoverTrigger,
	DispatchResult,
	AttemptRecord,
	CircuitState,
	ChatRequest,
	ChatResult,
	ProviderRef,
} from './types.js';
