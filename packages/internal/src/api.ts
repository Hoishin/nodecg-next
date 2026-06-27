import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

import { AuthenticationMiddleware, IdentitySchema } from "./auth.ts";
import { JsonValueSchema } from "./utils/json-value-schema.ts";

const StateGroup = HttpApiGroup.make("State")
	.add(
		HttpApiEndpoint.get(
			"get",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/state/${HttpApiSchema.param("name", Schema.String)}`
			.addSuccess(JsonValueSchema)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.InternalServerError),
	)
	.add(
		HttpApiEndpoint.put(
			"update",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/state/${HttpApiSchema.param("name", Schema.String)}`
			.setPayload(JsonValueSchema)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.InternalServerError),
	);

const ComputedGroup = HttpApiGroup.make("Computed").add(
	HttpApiEndpoint.get(
		"get",
	)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/computed/${HttpApiSchema.param("name", Schema.String)}`
		.addSuccess(JsonValueSchema)
		.addError(HttpApiError.NotFound)
		.addError(HttpApiError.InternalServerError),
);

const HealthGroup = HttpApiGroup.make("Health").add(
	HttpApiEndpoint.get("ping", "/ping").addSuccess(Schema.String),
);

const AuthenticationGroup = HttpApiGroup.make("Authentication")
	.add(
		HttpApiEndpoint.get("me", "/me").addSuccess(
			Schema.Struct({
				identity: IdentitySchema,
			}),
		),
	)
	.add(
		HttpApiEndpoint.post(
			"login",
		)`/authentication/login/${HttpApiSchema.param("provider", Schema.String)}`
			.addSuccess(HttpApiSchema.Empty(302))
			.addError(HttpApiError.InternalServerError),
	)
	.add(
		HttpApiEndpoint.get(
			"callback",
		)`/authentication/callback/${HttpApiSchema.param("provider", Schema.String)}`
			.addSuccess(HttpApiSchema.Empty(302))
			.addError(HttpApiError.InternalServerError),
	)
	.add(
		HttpApiEndpoint.post("logout", "/authentication/logout")
			.addSuccess(HttpApiSchema.Empty(204))
			.addError(HttpApiError.InternalServerError),
	);

export const NodecgApi = HttpApi.make("NodecgApi")
	.add(HealthGroup)
	.add(StateGroup)
	.add(ComputedGroup)
	.add(AuthenticationGroup)
	.middleware(AuthenticationMiddleware)
	.prefix("/api");
