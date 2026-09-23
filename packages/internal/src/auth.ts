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

export const HumanIdentity = Schema.TaggedStruct("human", {
	account: HumanAccountSchema,
	roles: Schema.Array(Role),
	globalRoles: Schema.Array(GlobalRoleName),
});
export type HumanIdentity = typeof HumanIdentity.Type;

export const MachineIdentity = Schema.TaggedStruct("machine", {
	id: Schema.String,
	displayName: Schema.String,
	roles: Schema.Array(Role),
	globalRoles: Schema.Array(GlobalRoleName),
});
export type MachineIdentity = typeof MachineIdentity.Type;

export const ServerIdentity = Schema.TaggedStruct("server", {});
export type ServerIdentity = typeof ServerIdentity.Type;

export const Identity = Schema.Union([
	AnonymousIdentitySchema,
	HumanIdentity,
	MachineIdentity,
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

export class HumanAuthenticationMiddleware extends HttpApiMiddleware.Service<
	HumanAuthenticationMiddleware,
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

export class MachineAuthenticationMiddleware extends HttpApiMiddleware.Service<
	MachineAuthenticationMiddleware,
	{ provides: CurrentIdentity }
>()("MachineAuthentication", {
	error: HttpApiError.Unauthorized,
	security: { bearer: HttpApiSecurity.bearer },
}) {}
