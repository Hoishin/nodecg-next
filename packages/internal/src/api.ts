import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

export const ClientMessage = Schema.Union(
	Schema.TaggedStruct("subscribe", { topic: Schema.String }),
	Schema.TaggedStruct("ping", {}),
);
export type ClientMessage = typeof ClientMessage.Type;

export const ServerMessage = Schema.Union(Schema.TaggedStruct("pong", {}));
export type ServerMessage = typeof ServerMessage.Type;

export const PublishPayload = Schema.Struct({
	topic: Schema.String,
	value: Schema.Unknown,
});

const StateGroup = HttpApiGroup.make("State")
	.add(
		HttpApiEndpoint.get(
			"get",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/state/${HttpApiSchema.param("name", Schema.String)}`
			.addSuccess(Schema.Unknown)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.NotImplemented),
	)
	.add(
		HttpApiEndpoint.put(
			"update",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/state/${HttpApiSchema.param("name", Schema.String)}`
			.setPayload(Schema.Unknown)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.NotImplemented),
	);

const HealthGroup = HttpApiGroup.make("Health").add(
	HttpApiEndpoint.get("ping", "/ping").addSuccess(Schema.String),
);

export const NodecgApi = HttpApi.make("NodecgApi")
	.add(HealthGroup)
	.add(StateGroup)
	.prefix("/api");
