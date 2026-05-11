import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

export const ClientMessage = Schema.Union(
	Schema.TaggedStruct("subscribe", { topic: Schema.String }),
	Schema.TaggedStruct("publish", {
		topic: Schema.String,
		value: Schema.Unknown,
	}),
	Schema.TaggedStruct("ping", {}),
);
export type ClientMessage = typeof ClientMessage.Type;

export const ServerMessage = Schema.Union(Schema.TaggedStruct("pong", {}));
export type ServerMessage = typeof ServerMessage.Type;

export const NodecgApi = HttpApi.make("NodecgApi")
	.add(
		HttpApiGroup.make("Root").add(
			HttpApiEndpoint.get("root", "/").addError(HttpApiError.NotImplemented),
		),
	)
	.add(
		HttpApiGroup.make("Api").add(
			HttpApiEndpoint.get("ping", "/api/ping").addSuccess(Schema.String),
		),
	);
