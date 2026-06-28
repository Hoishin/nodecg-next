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

export const RESERVED_ROLE_SET = new Set<RoleName>(
	Object.values(RESERVED_ROLE),
);
