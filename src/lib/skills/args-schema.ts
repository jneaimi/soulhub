/**
 * JSON-Schema → Zod compiler — scoped to the subset documented in ADR-009 §7.
 *
 * Hand-rolled (vs adding `json-schema-to-zod` as a dep) because the surface
 * we need is small and stable: object root, string / number / boolean / array
 * leaves, `enum`, `default`, `minLength` / `maxLength` / `min` / `max`,
 * `required`, and `description` for tool-time documentation.
 *
 * Anything outside this subset (allOf, oneOf, $ref, integer formats, regex
 * patterns) returns a permissive `z.unknown()` so the compiler never throws
 * — the orchestrator falls back to "parse-but-don't-validate" rather than
 * refusing to register the skill.
 */

import { z, type ZodTypeAny } from 'zod';

interface JsonSchemaNode {
	type?: string | string[];
	enum?: unknown[];
	default?: unknown;
	description?: string;
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	required?: string[];
	properties?: Record<string, JsonSchemaNode>;
	items?: JsonSchemaNode;
}

/** Compile a JSON Schema fragment to a Zod type. The orchestrator calls
 *  `parseArgs(input)` on the resulting schema to validate user-supplied
 *  args before invoking the skill. */
export function compileArgsSchema(schema: unknown): ZodTypeAny {
	if (!schema || typeof schema !== 'object') return z.unknown();
	return compileNode(schema as JsonSchemaNode);
}

function compileNode(node: JsonSchemaNode): ZodTypeAny {
	if (Array.isArray(node.enum) && node.enum.length > 0) {
		return wrap(buildEnum(node.enum), node);
	}
	const t = Array.isArray(node.type) ? node.type[0] : node.type;
	switch (t) {
		case 'string': {
			let s = z.string();
			if (typeof node.minLength === 'number') s = s.min(node.minLength);
			if (typeof node.maxLength === 'number') s = s.max(node.maxLength);
			return wrap(s, node);
		}
		case 'number':
		case 'integer': {
			let n = z.number();
			if (typeof node.minimum === 'number') n = n.min(node.minimum);
			if (typeof node.maximum === 'number') n = n.max(node.maximum);
			if (t === 'integer') n = n.int();
			return wrap(n, node);
		}
		case 'boolean':
			return wrap(z.boolean(), node);
		case 'array': {
			const inner = node.items ? compileNode(node.items) : z.unknown();
			return wrap(z.array(inner), node);
		}
		case 'object': {
			const props = node.properties ?? {};
			const required = new Set(node.required ?? []);
			const shape: Record<string, ZodTypeAny> = {};
			for (const [key, child] of Object.entries(props)) {
				let field = compileNode(child);
				if (!required.has(key)) field = field.optional();
				shape[key] = field;
			}
			return wrap(z.object(shape), node);
		}
		default:
			return wrap(z.unknown(), node);
	}
}

function wrap(t: ZodTypeAny, node: JsonSchemaNode): ZodTypeAny {
	let out = t;
	if (typeof node.description === 'string' && node.description.trim()) {
		out = out.describe(node.description.trim());
	}
	if (node.default !== undefined) {
		// Zod 4 `prefault` (per saved memory `feedback_zod_v4_prefault`) — keeps
		// partial inputs flowing to inner-field defaults instead of forcing
		// callers to supply the full shape.
		out = (out as ZodTypeAny & { prefault?: (v: unknown) => ZodTypeAny }).prefault?.(node.default) ?? out.default(node.default);
	}
	return out;
}

function buildEnum(values: unknown[]): ZodTypeAny {
	const strs = values.filter((v): v is string => typeof v === 'string');
	if (strs.length === values.length && strs.length > 0) {
		return z.enum(strs as [string, ...string[]]);
	}
	// Mixed-type enum — fall back to a literal union.
	const literals: ZodTypeAny[] = values.map((v) => z.literal(v as string | number | boolean));
	if (literals.length === 0) return z.unknown();
	if (literals.length === 1) return literals[0];
	return z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}
