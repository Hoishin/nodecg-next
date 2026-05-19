import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

const StateGroup = HttpApiGroup.make("State")
	.add(
		HttpApiEndpoint.get(
			"get",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/state/${HttpApiSchema.param("name", Schema.String)}`
			.addSuccess(Schema.Unknown)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.InternalServerError),
	)
	.add(
		HttpApiEndpoint.put(
			"update",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/state/${HttpApiSchema.param("name", Schema.String)}`
			.setPayload(Schema.Unknown)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.InternalServerError),
	);

const HealthGroup = HttpApiGroup.make("Health").add(
	HttpApiEndpoint.get("ping", "/ping").addSuccess(Schema.String),
);

export const NodecgApi = HttpApi.make("NodecgApi")
	.add(HealthGroup)
	.add(StateGroup)
	.prefix("/api");
