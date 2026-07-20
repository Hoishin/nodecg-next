import { Schema } from "effect";

import { JsonValueSchema } from "./utils/json-value-schema.ts";

const FieldType = Schema.Literal("replicant", "computed", "topic");

const FieldIdentifierSchema = Schema.Struct({
	type: FieldType,
	namespace: Schema.String,
	name: Schema.String,
});

export type FieldIdentifier = typeof FieldIdentifierSchema.Type;

export const fieldIdentifierEquivalence = Schema.equivalence(
	FieldIdentifierSchema,
);

export const SubscribeMessage = Schema.TaggedStruct("subscribe", {
	field: FieldIdentifierSchema,
});

export const UnsubscribeMessage = Schema.TaggedStruct("unsubscribe", {
	field: FieldIdentifierSchema,
});

export const PingMessage = Schema.TaggedStruct("ping", {
	kind: Schema.Union(Schema.Literal("ping"), Schema.Literal("pong")),
});

export const ClientMessage = Schema.Union(
	SubscribeMessage,
	UnsubscribeMessage,
	PingMessage,
);
export type ClientMessage = typeof ClientMessage.Type;

export const PublishMessage = Schema.TaggedStruct("publish", {
	field: FieldIdentifierSchema,
	value: JsonValueSchema,
});

export const SubscribeRejectedMessage = Schema.TaggedStruct(
	"subscribe-rejected",
	{
		field: FieldIdentifierSchema,
		reason: Schema.Literal("forbidden", "not-found", "unavailable"),
		message: Schema.optional(Schema.String),
	},
);
export type SubscribeRejectedMessage = typeof SubscribeRejectedMessage.Type;

export const ServerMessage = Schema.Union(
	PublishMessage,
	SubscribeRejectedMessage,
	PingMessage,
);
export type ServerMessage = typeof ServerMessage.Type;
