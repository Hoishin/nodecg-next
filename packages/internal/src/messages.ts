import { Schema } from "effect";

import { JsonValueSchema } from "./utils/json-value-schema.ts";

const ReplicantFieldIdentifier = Schema.Struct({
	type: Schema.Literal("replicant"),
	namespace: Schema.String,
	name: Schema.String,
});
export type ReplicantFieldIdentifier = typeof ReplicantFieldIdentifier.Type;
const ComputedFieldIdentifier = Schema.Struct({
	type: Schema.Literal("computed"),
	namespace: Schema.String,
	name: Schema.String,
});
export type ComputedFieldIdentifier = typeof ComputedFieldIdentifier.Type;
const TopicFieldIdentifier = Schema.Struct({
	type: Schema.Literal("topic"),
	namespace: Schema.String,
	name: Schema.String,
});
export type TopicFieldIdentifier = typeof TopicFieldIdentifier.Type;

const FieldIdentifier = Schema.Union(
	ReplicantFieldIdentifier,
	ComputedFieldIdentifier,
	TopicFieldIdentifier,
);
export type FieldIdentifier = typeof FieldIdentifier.Type;

export const SubscribeMessage = Schema.TaggedStruct("subscribe", {
	field: FieldIdentifier,
});

export const UnsubscribeMessage = Schema.TaggedStruct("unsubscribe", {
	field: FieldIdentifier,
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

export const ReplicantSnapshotMessage = Schema.TaggedStruct("snapshot", {
	field: ReplicantFieldIdentifier,
	value: JsonValueSchema,
	revision: Schema.Number,
});
export type ReplicantSnapshotMessage = typeof ReplicantSnapshotMessage.Type;

export const FieldValueMessage = Schema.TaggedStruct("value", {
	field: Schema.Union(ComputedFieldIdentifier, TopicFieldIdentifier),
	value: JsonValueSchema,
});
export type FieldValueMessage = typeof FieldValueMessage.Type;

export const PublishMessage = Schema.Union(
	ReplicantSnapshotMessage,
	FieldValueMessage,
);
export type PublishMessage = typeof PublishMessage.Type;

export const SubscribeRejectedMessage = Schema.TaggedStruct(
	"subscribe-rejected",
	{
		field: FieldIdentifier,
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
