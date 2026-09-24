import { Context, Schema } from "effect";
import {
	HttpApiError,
	HttpApiMiddleware,
	HttpApiSecurity,
} from "effect/unstable/httpapi";

import { GlobalRoleName, Role } from "./role.ts";

export const AnonymousIdentitySchema = Schema.TaggedStruct("anonymous", {});

export const Login = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
});
export type Login = typeof Login.Type;

export const HumanAccountSchema = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	displayName: Schema.String,
});
export type HumanAccount = typeof HumanAccountSchema.Type;

export const UserIdentity = Schema.TaggedStruct("user", {
	account: HumanAccountSchema,
	roles: Schema.Array(Role),
	globalRoles: Schema.Array(GlobalRoleName),
});
export type UserIdentity = typeof UserIdentity.Type;

export const ServiceAccountIdentity = Schema.TaggedStruct("serviceAccount", {
	id: Schema.String,
	displayName: Schema.String,
	roles: Schema.Array(Role),
	globalRoles: Schema.Array(GlobalRoleName),
});
export type ServiceAccountIdentity = typeof ServiceAccountIdentity.Type;

export const ServerIdentity = Schema.TaggedStruct("server", {});
export type ServerIdentity = typeof ServerIdentity.Type;

export const Identity = Schema.Union([
	AnonymousIdentitySchema,
	UserIdentity,
	ServiceAccountIdentity,
	ServerIdentity,
]);
export type Identity = typeof Identity.Type;

export class CurrentIdentity extends Context.Service<
	CurrentIdentity,
	Identity
>()("CurrentIdentity") {}

export const sessionCookieName = "nodecg.sid";

export const sessionCookieSecurity = HttpApiSecurity.apiKey({
	key: sessionCookieName,
	in: "cookie",
});

export class UserAuthenticationMiddleware extends HttpApiMiddleware.Service<
	UserAuthenticationMiddleware,
	{ provides: CurrentIdentity }
>()("Authentication", {
	error: HttpApiError.Unauthorized,
	security: { cookie: sessionCookieSecurity },
}) {}

export class AdminTierMiddleware extends HttpApiMiddleware.Service<
	AdminTierMiddleware,
	{ requires: CurrentIdentity }
>()("AdminTier", { error: HttpApiError.Forbidden }) {}

export class SuperadminMiddleware extends HttpApiMiddleware.Service<
	SuperadminMiddleware,
	{ requires: CurrentIdentity }
>()("Superadmin", { error: HttpApiError.Forbidden }) {}

export class ServiceAccountAuthenticationMiddleware extends HttpApiMiddleware.Service<
	ServiceAccountAuthenticationMiddleware,
	{ provides: CurrentIdentity }
>()("ServiceAccountAuthentication", {
	error: HttpApiError.Unauthorized,
	security: { bearer: HttpApiSecurity.bearer },
}) {}
