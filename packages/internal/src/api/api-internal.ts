import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

import { HumanAuthenticationMiddleware, IdentitySchema } from "../auth.ts";
import { RoleNameSchema } from "../role.ts";
import { fieldGroup } from "./shared.ts";

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
	.add(fieldGroup("Field"))
	.add(AuthenticationGroup)
	.add(RolesGroup)
	.middleware(HumanAuthenticationMiddleware)
	.prefix("/api/internal");
