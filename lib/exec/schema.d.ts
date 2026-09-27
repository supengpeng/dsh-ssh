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
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';
/** One model-facing text block, structurally identical to the Host's TextBlock. */
export interface TextBlock {
    type: 'text';
    text: string;
}
/** Lossless JSON, structurally identical to the Host's `JsonValue`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** An object node; openness is always explicit. */
export declare function objectNode(properties: Record<string, JsonSchemaNode>, required?: readonly string[], options?: {
    description?: string;
    additionalProperties?: boolean;
}): JsonSchemaNode;
/**
 * A tool's parameter root.
 *
 * Openness is `true`, matching the schemas DSH's own tools publish: a model that
 * sends an unexpected key gets an ordinary argument error naming the key instead
 * of a transport-level schema violation.
 */
export declare function parameterRoot(properties: Record<string, JsonSchemaNode>): Record<string, unknown>;
/** A free-form string map (the `env` argument). */
export declare function mapNode(description: string): JsonSchemaNode;
export declare function stringNode(description: string, extra?: {
    enum?: readonly string[];
}): JsonSchemaNode;
export declare function integerNode(description: string): JsonSchemaNode;
export declare function booleanNode(description: string): JsonSchemaNode;
export declare function arrayNode(description: string, items: JsonSchemaNode): JsonSchemaNode;
/** A nullable node: the contract has no `type` arrays, so nullability is a `oneOf`. */
export declare function nullable(node: JsonSchemaNode): JsonSchemaNode;
export declare function text(value: string): TextBlock;
/** Join optional lines, dropping empty ones. */
export declare function lines(...parts: Array<string | false | null | undefined>): string;
/**
 * Make a value safe for the tool-result contract.
 *
 * The registry snapshots every returned value as lossless JSON and rejects
 * anything else (`undefined`, `NaN`, `Infinity`, `BigInt`, class instances), so
 * every result passes through here before it is returned.
 */
export declare function toLossless<T>(value: T): T;
//# sourceMappingURL=schema.d.ts.map