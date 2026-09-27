/**
 * JSON Schema and content-block helpers for tool definitions.
 *
 * The DSH tool contract accepts a raw JSON Schema node and enforces a small
 * keyword subset — `type`, `oneOf`, `properties`, `required`,
 * `additionalProperties`, `items`, `enum`, `const`, `description`, `title`,
 * `default`, `examples`. Building every node through these helpers keeps a
 * `ssh_exec` schema inside that subset by construction.
 *
 * The content-block shape is declared structurally rather than imported from
 * `@deepseek-ai/dsh-llm`: that package is not a dependency of this plugin, and a
 * text block is `{ type: 'text', text }` in the Host contract.
 */

import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

/** One model-facing text block, structurally identical to the Host's TextBlock. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Lossless JSON, structurally identical to the Host's `JsonValue`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** An object node; openness is always explicit. */
export function objectNode(
  properties: Record<string, JsonSchemaNode>,
  required: readonly string[] = [],
  options: { description?: string; additionalProperties?: boolean } = {},
): JsonSchemaNode {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: options.additionalProperties ?? false,
    ...(options.description ? { description: options.description } : {}),
  }
}

/**
 * A tool's parameter root.
 *
 * Openness is `true`, matching the schemas DSH's own tools publish: a model that
 * sends an unexpected key gets an ordinary argument error naming the key instead
 * of a transport-level schema violation.
 */
export function parameterRoot(properties: Record<string, JsonSchemaNode>): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: true }
}

/** A free-form string map (the `env` argument). */
export function mapNode(description: string): JsonSchemaNode {
  return { type: 'object', additionalProperties: true, description, properties: {} }
}

export function stringNode(description: string, extra: { enum?: readonly string[] } = {}): JsonSchemaNode {
  return { type: 'string', description, ...(extra.enum ? { enum: [...extra.enum] } : {}) }
}

export function integerNode(description: string): JsonSchemaNode {
  return { type: 'integer', description }
}

export function booleanNode(description: string): JsonSchemaNode {
  return { type: 'boolean', description }
}

export function arrayNode(description: string, items: JsonSchemaNode): JsonSchemaNode {
  return { type: 'array', description, items }
}

/** A nullable node: the contract has no `type` arrays, so nullability is a `oneOf`. */
export function nullable(node: JsonSchemaNode): JsonSchemaNode {
  return { oneOf: [node, { type: 'null' }] }
}

export function text(value: string): TextBlock {
  return { type: 'text', text: value }
}

/** Join optional lines, dropping empty ones. */
export function lines(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
}

/**
 * Make a value safe for the tool-result contract.
 *
 * The registry snapshots every returned value as lossless JSON and rejects
 * anything else (`undefined`, `NaN`, `Infinity`, `BigInt`, class instances), so
 * every result passes through here before it is returned.
 */
export function toLossless<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) return null
      if (typeof item === 'bigint') return Number(item)
      if (typeof item === 'function' || typeof item === 'symbol') return null
      return item
    }),
  ) as T
}
