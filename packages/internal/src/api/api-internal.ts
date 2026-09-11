import { Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/unstable/httpapi";

import {
	AdminTierMiddleware,
	HumanAuthenticationMiddleware,
	IdentitySchema,
	SuperadminMiddleware,
} from "../auth.ts";
import {
	AdminRoleNameSchema,
	GlobalRoleNameSchema,
	RoleNameSchema,
} from "../role.ts";
import { MalformedUrl } from "../utils/relative-url.ts";
import { fieldGroup } from "./shared.ts";

export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()(
	"TooManyRequests",
	{},
) {}

export class RoleImportError extends Schema.TaggedError<RoleImportError>()(
	"RoleImportError",
	{ message: Schema.String },
) {}

const RoleAssignmentResultSchema = Schema.Struct({
	roles: Schema.ReadonlySet(RoleNameSchema),
});

const GlobalRoleAssignmentResultSchema = Schema.Struct({
	roles: Schema.ReadonlySet(GlobalRoleNameSchema),
});

const NamespacePermissionsSchema = Schema.Struct({
	roles: Schema.ReadonlySet(RoleNameSchema),
});
export const MePayloadSchema = Schema.Struct({
	identity: IdentitySchema,
	namespaces: Schema.Record(Schema.String, NamespacePermissionsSchema),
});
export type MePayload = typeof MePayloadSchema.Type;

export const LoginProviderSchema = Schema.Struct({
	name: Schema.String,
	url: Schema.String,
});
export type LoginProvider = typeof LoginProviderSchema.Type;

const ClaimSuperadminRequestSchema = Schema.Struct({
	token: Schema.Redacted(Schema.String),
});

const ReturnToSchema = Schema.String.check(
	Schema.isPattern(/^\/(?![/\\])/, {
		description: "a same-origin relative path",
	}),
);

const AuthenticationGroup = HttpApiGroup.make("Authentication")
	.add(HttpApiEndpoint.get("me", "/me", { success: MePayloadSchema }))
	.add(
		HttpApiEndpoint.get("providers", "/authentication/providers", {
			success: Schema.Array(LoginProviderSchema),
		}),
	)
	.add(
		HttpApiEndpoint.get("login", "/authentication/login/:provider", {
			params: { provider: Schema.String },
			query: { returnTo: Schema.optional(ReturnToSchema) },
			success: HttpApiSchema.Empty(302),
			error: [
				HttpApiError.InternalServerError,
				MalformedUrl.pipe(HttpApiSchema.status(400)),
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("callback", "/authentication/callback/:provider", {
			params: { provider: Schema.String },
			success: HttpApiSchema.Empty(302),
			error: [
				HttpApiError.InternalServerError,
				MalformedUrl.pipe(HttpApiSchema.status(400)),
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("logout", "/authentication/logout", {
			success: HttpApiSchema.Empty(204),
			error: HttpApiError.InternalServerError,
		}),
	)
	.add(
		HttpApiEndpoint.post(
			"claimSuperadmin",
			"/authentication/claim-superadmin",
			{
				payload: ClaimSuperadminRequestSchema,
				success: GlobalRoleAssignmentResultSchema,
				error: [
					HttpApiError.Forbidden,
					TooManyRequests.pipe(HttpApiSchema.status(429)),
				],
			},
		),
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
	globalRoles: Schema.ReadonlySet(GlobalRoleNameSchema),
});

export const MachineAssignmentSchema = Schema.TaggedStruct("machine", {
	id: Schema.String,
	roles: Schema.ReadonlySet(RoleNameSchema),
	globalRoles: Schema.ReadonlySet(GlobalRoleNameSchema),
});

export const RoleAssignmentsDocument = Schema.Struct({
	version: Schema.Literal(0),
	assignments: Schema.Array(
		Schema.Union([HumanAssignmentSchema, MachineAssignmentSchema]),
	),
});
export type RoleAssignmentsDocument = typeof RoleAssignmentsDocument.Type;

const ImportAssignmentsRequestSchema = Schema.Struct({
	mode: Schema.Literals(["replace", "merge"]),
	document: RoleAssignmentsDocument,
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
	globalRoles: Schema.ReadonlySet(GlobalRoleNameSchema),
});

const ListMachinesResultSchema = Schema.Struct({
	machines: Schema.Array(MachineClientSchema),
});

const MachineRoleRequestSchema = Schema.Struct({
	role: RoleNameSchema,
});

const MachinesGroup = HttpApiGroup.make("Machines")
	.add(
		HttpApiEndpoint.post("createApiKey", "/machines", {
			payload: CreateApiKeyRequestSchema,
			success: CreateApiKeyResultSchema,
		}),
	)
	.add(
		HttpApiEndpoint.get("list", "/machines", {
			success: ListMachinesResultSchema,
		}),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/machines/:id", {
			params: { id: Schema.String },
			success: HttpApiSchema.Empty(204),
			error: HttpApiError.NotFound,
		}),
	)
	.add(
		HttpApiEndpoint.post("refresh", "/machines/:id/refresh", {
			params: { id: Schema.String },
			success: CreateApiKeyResultSchema,
			error: HttpApiError.NotFound,
		}),
	)
	.add(
		HttpApiEndpoint.post("grantRole", "/machines/:id/roles", {
			params: { id: Schema.String },
			payload: MachineRoleRequestSchema,
			success: RoleAssignmentResultSchema,
			error: HttpApiError.NotFound,
		}),
	)
	.add(
		HttpApiEndpoint.delete("revokeRole", "/machines/:id/roles/:role", {
			params: { id: Schema.String, role: RoleNameSchema },
			success: RoleAssignmentResultSchema,
			error: HttpApiError.NotFound,
		}),
	)
	.middleware(AdminTierMiddleware);

const RolesGroup = HttpApiGroup.make("Roles")
	.add(
		HttpApiEndpoint.post("grant", "/roles/grant", {
			payload: RoleAssignmentSchema,
			success: RoleAssignmentResultSchema,
		}),
	)
	.add(
		HttpApiEndpoint.post("revoke", "/roles/revoke", {
			payload: RoleAssignmentSchema,
			success: RoleAssignmentResultSchema,
		}),
	)
	.add(
		HttpApiEndpoint.get("export", "/roles/export", {
			success: RoleAssignmentsDocument,
		}),
	)
	.add(
		HttpApiEndpoint.post("import", "/roles/import", {
			payload: ImportAssignmentsRequestSchema,
			success: HttpApiSchema.Empty(204),
			error: RoleImportError.pipe(HttpApiSchema.status(400)),
		}),
	)
	.middleware(AdminTierMiddleware);

export const AdminSubjectSchema = Schema.Union([
	Schema.TaggedStruct("human", {
		issuer: Schema.String,
		subject: Schema.String,
	}),
	Schema.TaggedStruct("machine", { id: Schema.String }),
]);
export type AdminSubject = typeof AdminSubjectSchema.Type;

export const AdminRoleAssignmentSchema = Schema.Struct({
	subject: AdminSubjectSchema,
	role: AdminRoleNameSchema,
});
export type AdminRoleAssignment = typeof AdminRoleAssignmentSchema.Type;

const AdminRolesGroup = HttpApiGroup.make("AdminRoles")
	.add(
		HttpApiEndpoint.post("grantAdmin", "/admin-roles/grant", {
			payload: AdminRoleAssignmentSchema,
			success: GlobalRoleAssignmentResultSchema,
			error: HttpApiError.NotFound,
		}),
	)
	.add(
		HttpApiEndpoint.post("revokeAdmin", "/admin-roles/revoke", {
			payload: AdminRoleAssignmentSchema,
			success: GlobalRoleAssignmentResultSchema,
			error: HttpApiError.NotFound,
		}),
	)
	.middleware(SuperadminMiddleware);

export const InternalApi = HttpApi.make("InternalApi")
	.add(fieldGroup("Field"))
	.add(AuthenticationGroup)
	.add(MachinesGroup)
	.add(RolesGroup)
	.add(AdminRolesGroup)
	.middleware(HumanAuthenticationMiddleware)
	.prefix("/api/internal");
