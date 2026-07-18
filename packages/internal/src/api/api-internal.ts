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

export class TooManyRequests extends HttpApiSchema.EmptyError<TooManyRequests>()(
	{
		tag: "TooManyRequests",
		status: 429,
	},
) {}

export class RoleImportError extends Schema.TaggedError<RoleImportError>()(
	"RoleImportError",
	{ message: Schema.String },
	HttpApiSchema.annotations({ status: 400 }),
) {}

const RoleAssignmentResultSchema = Schema.Struct({
	roles: Schema.ReadonlySet(RoleNameSchema),
});

const ClaimSuperadminRequestSchema = Schema.Struct({
	token: Schema.Redacted(Schema.String),
});

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
	)
	.add(
		HttpApiEndpoint.post("claimSuperadmin", "/authentication/claim-superadmin")
			.setPayload(ClaimSuperadminRequestSchema)
			.addSuccess(RoleAssignmentResultSchema)
			.addError(HttpApiError.Forbidden)
			.addError(TooManyRequests),
	);

const RoleAssignmentSchema = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	role: RoleNameSchema,
});

export const HumanAssignmentSchema = Schema.TaggedStruct("human", {
	issuer: Schema.String,
	subject: Schema.String,
	roles: Schema.ReadonlySet(RoleNameSchema),
});

export const MachineAssignmentSchema = Schema.TaggedStruct("machine", {
	id: Schema.String,
	roles: Schema.ReadonlySet(RoleNameSchema),
});

export const RoleAssignmentsDocumentSchema = Schema.Struct({
	version: Schema.Literal(0),
	assignments: Schema.Array(
		Schema.Union(HumanAssignmentSchema, MachineAssignmentSchema),
	),
});
export type RoleAssignmentsDocument = typeof RoleAssignmentsDocumentSchema.Type;

const ImportAssignmentsRequestSchema = Schema.Struct({
	mode: Schema.Literal("replace", "merge"),
	document: RoleAssignmentsDocumentSchema,
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
	roles: Schema.ReadonlySet(RoleNameSchema),
});

const ListMachinesResultSchema = Schema.Struct({
	machines: Schema.Array(MachineClientSchema),
});

const MachineRoleRequestSchema = Schema.Struct({
	role: RoleNameSchema,
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
	)
	.add(
		// TODO: make a separate "grantAdminRole"
		HttpApiEndpoint.post(
			"grantRole",
		)`/machines/${HttpApiSchema.param("id", Schema.String)}/roles`
			.setPayload(MachineRoleRequestSchema)
			.addSuccess(RoleAssignmentResultSchema)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.NotFound),
	)
	.add(
		HttpApiEndpoint.del(
			"revokeRole",
		)`/machines/${HttpApiSchema.param("id", Schema.String)}/roles/${HttpApiSchema.param("role", RoleNameSchema)}`
			.addSuccess(RoleAssignmentResultSchema)
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
	)
	.add(
		HttpApiEndpoint.get("export", "/roles/export")
			.addSuccess(RoleAssignmentsDocumentSchema)
			.addError(HttpApiError.Forbidden),
	)
	.add(
		HttpApiEndpoint.post("import", "/roles/import")
			.setPayload(ImportAssignmentsRequestSchema)
			.addSuccess(HttpApiSchema.Empty(204))
			.addError(HttpApiError.Forbidden)
			.addError(RoleImportError),
	);

export const InternalApi = HttpApi.make("InternalApi")
	.add(fieldGroup("Field"))
	.add(AuthenticationGroup)
	.add(MachinesGroup)
	.add(RolesGroup)
	.middleware(HumanAuthenticationMiddleware)
	.prefix("/api/internal");
