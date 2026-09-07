import { Schema } from "effect";
import type { JsonValue } from "type-fest";

/**
 * See node_modules/type-fest/source/json-value.d.ts
 */
export const JsonValueSchema: Schema.Codec<JsonValue> = Schema.Union([
	Schema.String,
	Schema.Finite,
	Schema.Boolean,
	Schema.Null,
	Schema.suspend(() => Schema.Array(JsonValueSchema)),
	Schema.suspend(() => Schema.Record(Schema.String, JsonValueSchema)),
]);
