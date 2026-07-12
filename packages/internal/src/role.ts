import { Brand, Schema } from "effect";

export const RoleNameSchema = Schema.String.pipe(Schema.brand("Role"));
export type RoleName = typeof RoleNameSchema.Type;
export const RoleName = Brand.nominal<RoleName>();

export const RESERVED_ROLE = {
	// Unauthenticated users and users with no role
	everyone: RoleName("everyone"),
	// User with at least one role
	client: RoleName("client"),
	// Users who can assign others with roles except admin/superadmin
	admin: RoleName("admin"),
	// Users who can assign others with roles including admin/superadmin
	superadmin: RoleName("superadmin"),
	// Exclusive to server-side function calls
	server: RoleName("server"),
} as const;

export type ReservedRoleName = keyof typeof RESERVED_ROLE;

export const RESERVED_ROLE_SET = new Set(Object.values(RESERVED_ROLE));

export const USABLE_RESERVED_ROLE = {
	server: RESERVED_ROLE.server,
	client: RESERVED_ROLE.client,
	everyone: RESERVED_ROLE.everyone,
} as const;

export type UsableReservedRoleName = keyof typeof USABLE_RESERVED_ROLE;

export const USABLE_RESERVED_ROLE_SET = new Set(
	Object.values(USABLE_RESERVED_ROLE),
);
