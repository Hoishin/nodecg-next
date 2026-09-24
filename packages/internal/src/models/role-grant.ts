import { Schema } from "effect";

import { AccountId } from "./account.ts";
import { GlobalRoleName, Role } from "./role.ts";

export const RoleGrant = Schema.Struct({
	accountId: AccountId,
	role: Role,
});
export type RoleGrant = typeof RoleGrant.Type;

export const GlobalRoleGrant = Schema.Struct({
	accountId: AccountId,
	role: GlobalRoleName,
});
export type GlobalRoleGrant = typeof GlobalRoleGrant.Type;
