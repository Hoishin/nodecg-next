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

const CreateApiKeyRequestSchema = Schema.Struct({
	displayName: Schema.String,
});

const CreateApiKeyResultSchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	token: Schema.Redacted(Schema.String),
});

const MachineClientSchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
});

const ListMachinesResultSchema = Schema.Struct({
	machines: Schema.Array(MachineClientSchema),
});

const MachinesGroup = HttpApiGroup.make("Machines")
	.add(
		HttpApiEndpoint.post("createApiKey", "/machines")
			.setPayload(CreateApiKeyRequestSchema)
			.addSuccess(CreateApiKeyResultSchema)
			.addError(HttpApiError.Forbidden),
	)
	.add(
		HttpApiEndpoint.get("list", "/machines")
			.addSuccess(ListMachinesResultSchema)
			.addError(HttpApiError.Forbidden),
	)
	.add(
		HttpApiEndpoint.del(
			"revoke",
		)`/machines/${HttpApiSchema.param("id", Schema.String)}`
			.addSuccess(HttpApiSchema.Empty(204))
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.post(
			"refresh",
		)`/machines/${HttpApiSchema.param("id", Schema.String)}/refresh`
			.addSuccess(CreateApiKeyResultSchema)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	);

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
	.add(MachinesGroup)
	.add(RolesGroup)
	.middleware(HumanAuthenticationMiddleware)
	.prefix("/api/internal");
