import { Schema } from "effect";

const StateFilter = Schema.Struct({
	namespace: Schema.String,
	name: Schema.String,
});

const PingMessage = Schema.TaggedStruct("ping", {
	topic: Schema.Union(Schema.Literal("ping"), Schema.Literal("pong")),
});

export const ClientMessage = Schema.Union(
	Schema.TaggedStruct("subscribe", {
		topic: Schema.Literal("state"),
		message: Schema.Struct({ filter: StateFilter }),
	}),
	Schema.TaggedStruct("unsubscribe", {
		topic: Schema.Literal("state"),
		message: Schema.Struct({ filter: StateFilter }),
	}),
	PingMessage,
);
export type ClientMessage = typeof ClientMessage.Type;

export const ServerMessage = Schema.Union(
	Schema.TaggedStruct("ack-subscribe", {
		topic: Schema.Literal("state"),
		message: Schema.Struct({ filter: StateFilter }),
	}),
	Schema.TaggedStruct("publish", {
		topic: Schema.Literal("state"),
		message: Schema.Struct({ filter: StateFilter, value: Schema.Unknown }),
	}),
	PingMessage,
);
export type ServerMessage = typeof ServerMessage.Type;
