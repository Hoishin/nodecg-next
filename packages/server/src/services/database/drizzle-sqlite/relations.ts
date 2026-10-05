import { defineRelations } from "drizzle-orm";

import {
	accounts,
	authentications,
	globalRoleGrants,
	roleGrants,
	users,
} from "./tables.ts";

export const relations = defineRelations(
	{ accounts, users, authentications, roleGrants, globalRoleGrants },
	(r) => ({
		users: {
			account: r.one.accounts({
				from: r.users.accountId,
				to: r.accounts.id,
				optional: false,
			}),
			authentications: r.many.authentications({
				from: r.users.id,
				to: r.authentications.userId,
			}),
		},
		accounts: {
			roleGrants: r.many.roleGrants({
				from: r.accounts.id,
				to: r.roleGrants.accountId,
			}),
			globalRoleGrants: r.many.globalRoleGrants({
				from: r.accounts.id,
				to: r.globalRoleGrants.accountId,
			}),
		},
	}),
);
