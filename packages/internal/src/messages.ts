import { Schema } from "effect";

import { JsonValueSchema } from "./utils/json-value-schema.ts";

const FieldType = Schema.Literal("state", "computed", "topic");

const FieldIdentifierSchema = Schema.Struct({
	type: FieldType,
	namespace: Schema.String,
	name: Schema.String,
});

export type FieldIdentifier = typeof FieldIdentifierSchema.Type;

export const fieldIdentifierEquivalence = Schema.equivalence(
	FieldIdentifierSchema,
);

const PingMessage = Schema.TaggedStruct("ping", {
	kind: Schema.Union(Schema.Literal("ping"), Schema.Literal("pong")),
});

export const ClientMessage = Schema.Union(
	Schema.TaggedStruct("subscribe", { field: FieldIdentifierSchema }),
	Schema.TaggedStruct("unsubscribe", { field: FieldIdentifierSchema }),
	PingMessage,
);
export type ClientMessage = typeof ClientMessage.Type;

export const SubscribeRejectedMessage = Schema.TaggedStruct(
	"subscribe-rejected",
	{
		field: FieldIdentifierSchema,
		reason: Schema.Literal("forbidden", "not-found"),
	},
);
export type SubscribeRejectedMessage = typeof SubscribeRejectedMessage.Type;

export const ServerMessage = Schema.Union(
	Schema.TaggedStruct("publish", {
		field: FieldIdentifierSchema,
		value: JsonValueSchema,
	}),
	SubscribeRejectedMessage,
	PingMessage,
);
export type ServerMessage = typeof ServerMessage.Type;
