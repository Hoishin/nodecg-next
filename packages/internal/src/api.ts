import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

import { AuthenticationMiddleware, IdentitySchema } from "./auth.ts";
import { RoleNameSchema } from "./role.ts";
import { JsonValueSchema } from "./utils/json-value-schema.ts";

const ReplicantGroup = HttpApiGroup.make("Replicant")
	.add(
		HttpApiEndpoint.get(
			"get",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/replicant/${HttpApiSchema.param("name", Schema.String)}`
			.addSuccess(JsonValueSchema)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.InternalServerError),
	)
	.add(
		HttpApiEndpoint.put(
			"update",
		)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/replicant/${HttpApiSchema.param("name", Schema.String)}`
			.setPayload(JsonValueSchema)
			.addError(HttpApiError.NotFound)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.InternalServerError),
	);

const ComputedGroup = HttpApiGroup.make("Computed").add(
	HttpApiEndpoint.get(
		"get",
	)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/computed/${HttpApiSchema.param("name", Schema.String)}`
		.addSuccess(JsonValueSchema)
		.addError(HttpApiError.NotFound)
		.addError(HttpApiError.Forbidden)
		.addError(HttpApiError.InternalServerError),
);

const TopicGroup = HttpApiGroup.make("Topic").add(
	HttpApiEndpoint.post(
		"publish",
	)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/topic/${HttpApiSchema.param("name", Schema.String)}`
		.setPayload(JsonValueSchema)
		.addError(HttpApiError.NotFound)
		.addError(HttpApiError.Forbidden)
		.addError(HttpApiError.BadRequest),
);

export class RpcCallError extends Schema.TaggedError<RpcCallError>()(
	"RpcCallError",
	{ message: Schema.String },
	HttpApiSchema.annotations({ status: 500 }),
) {}

const RpcGroup = HttpApiGroup.make("Rpc").add(
	HttpApiEndpoint.post(
		"call",
	)`/namespaces/${HttpApiSchema.param("namespace", Schema.String)}/rpc/${HttpApiSchema.param("name", Schema.String)}`
		.setPayload(JsonValueSchema)
		.addSuccess(JsonValueSchema)
		.addError(HttpApiError.NotFound)
		.addError(HttpApiError.Forbidden)
		.addError(HttpApiError.BadRequest)
		.addError(RpcCallError),
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

const RoleAssignmentSchema = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	role: RoleNameSchema,
});

const RoleAssignmentResultSchema = Schema.Struct({
	roles: Schema.ReadonlySet(RoleNameSchema),
});

const RolesGroup = HttpApiGroup.make("Roles")
	.add(
		HttpApiEndpoint.post("grant", "/roles/grant")
			.setPayload(RoleAssignmentSchema)
			.addSuccess(RoleAssignmentResultSchema)
			.addError(HttpApiError.Forbidden),
	)
	.add(
		HttpApiEndpoint.post("revoke", "/roles/revoke")
			.setPayload(RoleAssignmentSchema)
			.addSuccess(RoleAssignmentResultSchema)
			.addError(HttpApiError.Forbidden),
	);

export const InternalApi = HttpApi.make("InternalApi")
	.add(HealthGroup)
	.add(ReplicantGroup)
	.add(ComputedGroup)
	.add(TopicGroup)
	.add(RpcGroup)
	.add(AuthenticationGroup)
	.add(RolesGroup)
	.middleware(AuthenticationMiddleware)
	.prefix("/api/internal");
