import { Schema } from "effect";

import { Authentication } from "./authentication.ts";
import { GlobalRoleName, Role } from "./role.ts";

export const AnonymousIdentitySchema = Schema.TaggedStruct("anonymous", {});

export const UserIdentity = Schema.TaggedStruct("user", {
	account: Authentication,
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
