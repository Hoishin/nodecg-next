import { Brand, Either, Schema } from "effect";

import { PrincipalNameSchema } from "./principal.ts";

export const RoleNameSchema = Schema.String.pipe(Schema.brand("Role"));
export type RoleName = typeof RoleNameSchema.Type;
export const RoleName = Brand.nominal<RoleName>();

export const AdminRoleNameSchema = Schema.Literal("admin", "superadmin");

export const ADMIN_ROLE: Record<typeof AdminRoleNameSchema.Type, RoleName> = {
	admin: RoleName("admin"),
	superadmin: RoleName("superadmin"),
};

export const ADMIN_ROLE_BY_NAME = new Map(Object.entries(ADMIN_ROLE));

export const UndeclarableRoleSchema = Schema.Union(
	PrincipalNameSchema,
	AdminRoleNameSchema,
);

export type UndeclarableRoleName = typeof UndeclarableRoleSchema.Type;

export const isUndeclarableRole = (name: string) =>
	Schema.decodeUnknownEither(UndeclarableRoleSchema)(name).pipe(Either.isRight);
