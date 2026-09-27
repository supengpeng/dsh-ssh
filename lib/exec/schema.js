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
/** An object node; openness is always explicit. */
export function objectNode(properties, required = [], options = {}) {
    return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required: [...required] } : {}),
        additionalProperties: options.additionalProperties ?? false,
        ...(options.description ? { description: options.description } : {}),
    };
}
/**
 * A tool's parameter root.
 *
 * Openness is `true`, matching the schemas DSH's own tools publish: a model that
 * sends an unexpected key gets an ordinary argument error naming the key instead
 * of a transport-level schema violation.
 */
export function parameterRoot(properties) {
    return { type: 'object', properties, additionalProperties: true };
}
/** A free-form string map (the `env` argument). */
export function mapNode(description) {
    return { type: 'object', additionalProperties: true, description, properties: {} };
}
export function stringNode(description, extra = {}) {
    return { type: 'string', description, ...(extra.enum ? { enum: [...extra.enum] } : {}) };
}
export function integerNode(description) {
    return { type: 'integer', description };
}
export function booleanNode(description) {
    return { type: 'boolean', description };
}
export function arrayNode(description, items) {
    return { type: 'array', description, items };
}
/** A nullable node: the contract has no `type` arrays, so nullability is a `oneOf`. */
export function nullable(node) {
    return { oneOf: [node, { type: 'null' }] };
}
export function text(value) {
    return { type: 'text', text: value };
}
/** Join optional lines, dropping empty ones. */
export function lines(...parts) {
    return parts.filter((part) => typeof part === 'string' && part.length > 0).join('\n');
}
/**
 * Make a value safe for the tool-result contract.
 *
 * The registry snapshots every returned value as lossless JSON and rejects
 * anything else (`undefined`, `NaN`, `Infinity`, `BigInt`, class instances), so
 * every result passes through here before it is returned.
 */
export function toLossless(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item))
            return null;
        if (typeof item === 'bigint')
            return Number(item);
        if (typeof item === 'function' || typeof item === 'symbol')
            return null;
        return item;
    }));
}
//# sourceMappingURL=schema.js.map