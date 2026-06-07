import { Brand } from "effect";

export type RoleName = Brand.Brand<"Role"> & string;
export const RoleName = Brand.nominal<RoleName>();

export const RESERVED_ROLE = {
	superadmin: RoleName("superadmin"),
	server: RoleName("server"),
	client: RoleName("client"),
	public: RoleName("public"),
} as const;

export const RESERVED_ROLE_SET = new Set<RoleName>(
	Object.values(RESERVED_ROLE),
);
