import { Schema } from "effect";
import type { JsonValue } from "type-fest";

/**
 * See node_modules/type-fest/source/json-value.d.ts
 */
export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.Union(
	Schema.String,
	Schema.JsonNumber,
	Schema.Boolean,
	Schema.Null,
	Schema.suspend(() => Schema.Array(JsonValueSchema)),
	Schema.suspend(() =>
		Schema.Record({ key: Schema.String, value: JsonValueSchema }),
	),
);
