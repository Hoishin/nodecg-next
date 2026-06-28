import { HttpApiError, HttpApiMiddleware } from "@effect/platform";
import { Context, Schema } from "effect";

import { RoleNameSchema } from "./role.ts";

export const PublicIdentitySchema = Schema.TaggedStruct("public", {});

export const HumanAccountSchema = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	displayName: Schema.String,
});
export type HumanAccount = typeof HumanAccountSchema.Type;

export const HumanIdentitySchema = Schema.TaggedStruct("human", {
	account: HumanAccountSchema,
	roles: Schema.ReadonlySet(RoleNameSchema),
});
export type HumanIdentity = typeof HumanIdentitySchema.Type;

export const MachineIdentitySchema = Schema.TaggedStruct("machine", {
	id: Schema.String,
	displayName: Schema.String,
});
export type MachineIdentity = typeof MachineIdentitySchema.Type;

export const ServerIdentitySchema = Schema.TaggedStruct("server", {});
export type ServerIdentity = typeof ServerIdentitySchema.Type;

export const IdentitySchema = Schema.Union(
	PublicIdentitySchema,
	HumanIdentitySchema,
	MachineIdentitySchema,
	ServerIdentitySchema,
);
export type Identity = typeof IdentitySchema.Type;

export class CurrentIdentity extends Context.Tag("CurrentIdentity")<
	CurrentIdentity,
	Identity
>() {}

export class AuthenticationMiddleware extends HttpApiMiddleware.Tag<AuthenticationMiddleware>()(
	"Authentication",
	{
		provides: CurrentIdentity,
		failure: HttpApiError.Unauthorized,
	},
) {}
