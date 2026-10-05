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
	UserAuthenticationMiddleware,
	SuperadminMiddleware,
} from "../auth.ts";
import { AccountId } from "../models/account.ts";
import { Authentication } from "../models/authentication.ts";
import { Identity } from "../models/identity.ts";
import {
	AdminRoleName,
	GlobalRoleName,
	isUndeclarableRole,
	Role,
	RoleNameSchema,
} from "../models/role.ts";
import { ServiceAccountId } from "../models/service-account.ts";
import { UserId } from "../models/user.ts";
import { MalformedUrl } from "../utils/relative-url.ts";
import { fieldGroup } from "./shared.ts";

export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()(
	"TooManyRequests",
	{},
) {}

export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
	"PermissionDenied",
	{ message: Schema.String },
) {}

const NamespacePermissionsSchema = Schema.Struct({
	roles: Schema.Array(RoleNameSchema),
});
export const MePayload = Schema.Struct({
	identity: Identity,
	namespaces: Schema.Record(Schema.String, NamespacePermissionsSchema),
});
export type MePayload = typeof MePayload.Type;

export const LoginProvider = Schema.Struct({
	name: Schema.String,
	url: Schema.String,
});
export type LoginProvider = typeof LoginProvider.Type;

const ClaimSuperadminRequestSchema = Schema.Struct({
	token: Schema.Redacted(Schema.String),
});

const ReturnToSchema = Schema.String.check(
	Schema.isPattern(/^\/(?![/\\])/, {
		description: "a same-origin relative path",
	}),
);

const AuthenticationGroup = HttpApiGroup.make("Authentication")
	.add(HttpApiEndpoint.get("me", "/me", { success: MePayload }))
	.add(
		HttpApiEndpoint.get("providers", "/authentication/providers", {
			success: Schema.Array(LoginProvider),
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
				success: HttpApiSchema.Empty(204),
				error: [
					HttpApiError.Unauthorized,
					HttpApiError.Forbidden,
					TooManyRequests.pipe(HttpApiSchema.status(429)),
				],
			},
		),
	);

const DeclarableRoleName = RoleNameSchema.check(
	Schema.makeFilter((name) =>
		isUndeclarableRole(name) ? `role "${name}" cannot be assigned` : undefined,
	),
);

const DeclarableRole = Schema.Struct({
	namespace: Schema.String,
	name: DeclarableRoleName,
});

const RoleAssignmentSchema = Schema.Struct({
	accountId: AccountId,
	role: DeclarableRole,
});

export const UserAssignmentSchema = Schema.TaggedStruct("user", {
	authentication: Authentication,
	displayName: Schema.String,
	roles: Schema.Array(DeclarableRole),
	globalRoles: Schema.Tuple([]),
});

export const ServiceAccountAssignmentSchema = Schema.TaggedStruct(
	"serviceAccount",
	{
		id: ServiceAccountId,
		roles: Schema.Array(DeclarableRole),
		globalRoles: Schema.Tuple([]),
	},
);

export const RoleAssignmentsDocument = Schema.Struct({
	version: Schema.Literal(0),
	assignments: Schema.Array(
		Schema.Union([UserAssignmentSchema, ServiceAccountAssignmentSchema]),
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

export const CreateApiKeyResultSchema = Schema.Struct({
	serviceAccountId: ServiceAccountId,
	accountId: AccountId,
	displayName: Schema.String,
	token: Schema.Redacted(Schema.String),
});

const ServiceAccountSchema = Schema.Struct({
	id: Schema.String,
	accountId: AccountId,
	displayName: Schema.String,
	roles: Schema.Array(Role),
	globalRoles: Schema.Array(GlobalRoleName),
});

const ListServiceAccountsResultSchema = Schema.Struct({
	serviceAccounts: Schema.Array(ServiceAccountSchema),
});

const ServiceAccountsGroup = HttpApiGroup.make("ServiceAccounts")
	.add(
		HttpApiEndpoint.post("createApiKey", "/service-accounts", {
			payload: CreateApiKeyRequestSchema,
			success: CreateApiKeyResultSchema,
			error: HttpApiError.NotImplemented,
		}),
	)
	.add(
		HttpApiEndpoint.get("list", "/service-accounts", {
			success: ListServiceAccountsResultSchema,
		}),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/service-accounts/:id", {
			params: { id: ServiceAccountId },
			success: HttpApiSchema.Empty(204),
			error: HttpApiError.NotFound,
		}),
	)
	.add(
		HttpApiEndpoint.post("refresh", "/service-accounts/:id/refresh", {
			params: { id: ServiceAccountId },
			success: CreateApiKeyResultSchema,
			error: HttpApiError.NotFound,
		}),
	)
	.add(
		HttpApiEndpoint.post("grantRole", "/service-accounts/:id/roles", {
			params: { id: ServiceAccountId },
			payload: DeclarableRole,
			success: HttpApiSchema.Empty(204),
			error: [HttpApiError.NotFound, HttpApiError.UnprocessableEntity],
		}),
	)
	.add(
		HttpApiEndpoint.delete(
			"revokeRole",
			"/service-accounts/:id/namespaces/:namespace/roles/:name",
			{
				params: {
					id: ServiceAccountId,
					namespace: Schema.String,
					name: DeclarableRoleName,
				},
				success: HttpApiSchema.Empty(204),
				error: HttpApiError.NotFound,
			},
		),
	)
	.middleware(AdminTierMiddleware);

const UserSchema = Schema.Struct({
	id: UserId,
	accountId: AccountId,
	displayName: Schema.String,
	authentications: Schema.Array(Authentication),
	roles: Schema.Array(Role),
	globalRoles: Schema.Array(GlobalRoleName),
});

const ListUsersResult = Schema.Struct({
	users: Schema.Array(UserSchema),
});
type ListUsersResult = typeof ListUsersResult.Type;

const UsersGroup = HttpApiGroup.make("Users")
	.add(
		HttpApiEndpoint.get("list", "/users", {
			success: ListUsersResult,
		}),
	)
	.middleware(AdminTierMiddleware);

const RolesGroup = HttpApiGroup.make("Roles")
	.add(
		HttpApiEndpoint.post("grant", "/roles/grant", {
			payload: RoleAssignmentSchema,
			success: HttpApiSchema.Empty(204),
			error: [HttpApiError.NotFound, HttpApiError.UnprocessableEntity],
		}),
	)
	.add(
		HttpApiEndpoint.post("revoke", "/roles/revoke", {
			payload: RoleAssignmentSchema,
			success: HttpApiSchema.Empty(204),
			error: HttpApiError.NotFound,
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
		}),
	)
	.middleware(AdminTierMiddleware);

export const AdminRoleAssignmentSchema = Schema.Struct({
	accountId: AccountId,
	role: AdminRoleName,
});

const AdminRolesGroup = HttpApiGroup.make("AdminRoles")
	.add(
		HttpApiEndpoint.post("grantAdmin", "/admin-roles/grant", {
			payload: AdminRoleAssignmentSchema,
			success: HttpApiSchema.Empty(204),
			error: [
				HttpApiError.NotFound,
				PermissionDenied.pipe(HttpApiSchema.status(403)),
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("revokeAdmin", "/admin-roles/revoke", {
			payload: AdminRoleAssignmentSchema,
			success: HttpApiSchema.Empty(204),
			error: [
				HttpApiError.NotFound,
				PermissionDenied.pipe(HttpApiSchema.status(403)),
			],
		}),
	)
	.middleware(SuperadminMiddleware);

export const InternalApi = HttpApi.make("InternalApi")
	.add(fieldGroup("Field"))
	.add(AuthenticationGroup)
	.add(ServiceAccountsGroup)
	.add(UsersGroup)
	.add(RolesGroup)
	.add(AdminRolesGroup)
	.middleware(UserAuthenticationMiddleware)
	.prefix("/api/internal");
