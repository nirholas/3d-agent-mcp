// Shared helpers for the paid MCP tools.
//
// Single-sources the tool input schema: each tool declares its arguments ONCE
// as a Zod shape (an object of `{ field: ZodType }`), and the JSON Schema the
// MCP client / x402 bazaar sees is DERIVED from that shape via
// zod-to-json-schema. This kills the JSON-Schema↔Zod drift class — the two
// representations can no longer disagree because there is only one source.
//
// Re-exports `toolError` so tools can import their error contract + schema
// helper from a single module.

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export { toolError } from '../payments.js';

/**
 * Derive a MCP-shaped JSON Schema from a Zod shape (the same `{ field: ZodType }`
 * object passed to `McpServer.registerTool({ inputSchema })`).
 *
 * The output matches what the tools previously hand-wrote: a top-level
 * `{ type: 'object', properties, required, additionalProperties: false }`
 * with no `$schema`/`$ref` envelope, so the external contract MCP clients and
 * the x402 bazaar see is unchanged.
 *
 * @param {Record<string, import('zod').ZodTypeAny>} shape
 * @returns {object} JSON Schema (draft-07 object schema)
 */
export function jsonSchemaFromZod(shape) {
	const schema = zodToJsonSchema(z.object(shape).strict(), {
		// Inline everything — MCP clients expect a self-contained object schema,
		// not a `$ref`-into-`definitions` document.
		$refStrategy: 'none',
		target: 'jsonSchema7',
	});
	// zod-to-json-schema wraps the result with a `$schema` meta key; strip it so
	// the emitted schema is byte-for-byte the lean object schema the tools used
	// to hand-maintain.
	delete schema.$schema;
	return schema;
}
