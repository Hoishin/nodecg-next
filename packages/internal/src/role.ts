import { Brand, Schema } from "effect";

import { PrincipalNameSchema } from "./principal.ts";

export const RoleNameSchema = Schema.String.pipe(Schema.brand("Role"));
export type RoleName = typeof RoleNameSchema.Type;
export const RoleName = Brand.nominal<RoleName>();

export const AdminRoleNameSchema = Schema.Literals(["admin", "superadmin"]);
export type AdminRoleName = typeof AdminRoleNameSchema.Type;

export const ADMIN_TIER: ReadonlySet<AdminRoleName> = new Set(
	AdminRoleNameSchema.literals,
);

export const GlobalRoleNameSchema = Schema.Union([AdminRoleNameSchema]);
export type GlobalRoleName = typeof GlobalRoleNameSchema.Type;

export const UndeclarableRoleSchema = Schema.Union([
	PrincipalNameSchema,
	AdminRoleNameSchema,
]);

export type UndeclarableRoleName = typeof UndeclarableRoleSchema.Type;

export const isUndeclarableRole = Schema.is(UndeclarableRoleSchema);
