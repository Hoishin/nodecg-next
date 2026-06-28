import { Brand, Schema } from "effect";

export const RoleNameSchema = Schema.String.pipe(Schema.brand("Role"));
export type RoleName = typeof RoleNameSchema.Type;
export const RoleName = Brand.nominal<RoleName>();

export const RESERVED_ROLE = {
	superadmin: RoleName("superadmin"),
	admin: RoleName("admin"),
	server: RoleName("server"),
	client: RoleName("client"),
	public: RoleName("public"),
} as const;

export type ReservedRoleName = keyof typeof RESERVED_ROLE;

export const RESERVED_ROLE_SET = new Set(Object.values(RESERVED_ROLE));

export const USABLE_RESERVED_ROLE = {
	server: RESERVED_ROLE.server,
	client: RESERVED_ROLE.client,
	public: RESERVED_ROLE.public,
} as const;

export type UsableReservedRoleName = keyof typeof USABLE_RESERVED_ROLE;

export const USABLE_RESERVED_ROLE_SET = new Set(
	Object.values(USABLE_RESERVED_ROLE),
);
