import {
	ADMIN_ROLE,
	HumanAccountSchema,
	HumanIdentitySchema,
	MachineIdentitySchema,
	AnonymousIdentitySchema,
	RoleName,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import {
	declaredRoleNames,
	defineNamespace,
	extendNamespace,
} from "./define-namespace.ts";
import { getRolesFromIdentity, isAdminTier } from "./role.ts";

const human = (...roles: RoleName[]) =>
	HumanIdentitySchema.make({
		account: HumanAccountSchema.make({
			issuer: "test",
			subject: "subject",
			displayName: "Tester",
		}),
		roles: new Set(roles),
	});
const machine = (...roles: RoleName[]) =>
	MachineIdentitySchema.make({
		id: "robot",
		displayName: "Bot",
		roles: new Set(roles),
	});
const anonymous = AnonymousIdentitySchema.make();
const server = ServerIdentitySchema.make();

const manifest = defineNamespace("match", {
	roles: {
		judge: {
			permission: ["replicant-read", "replicant-write", "computed-read"],
		},
		viewer: { permission: ["replicant-read", "computed-read"] },
	},
	replicant: {
		score: {
			schema: Schema.Number,
			permission: { write: { allow: ["judge"] } },
		},
		open: {
			schema: Schema.Number,
			permission: { read: { everyone: "allow" } },
		},
		config: {
			schema: Schema.String,
			permission: { write: { allow: [] } },
		},
	},
	computed: { total: { schema: Schema.Number } },
});

describe("canRead / canWrite", () => {
	test("check the caller's roles against the field's read/write set", () => {
		expect(
			manifest.replicant.score.permission.canRead(human(RoleName("viewer"))),
		).toBe(true);
		expect(
			manifest.replicant.score.permission.canWrite(human(RoleName("viewer"))),
		).toBe(false);
		expect(
			manifest.replicant.score.permission.canWrite(human(RoleName("judge"))),
		).toBe(true);
	});

	test("admin and superadmin pass every field set by default", () => {
		expect(
			manifest.replicant.score.permission.canWrite(
				human(ADMIN_ROLE.superadmin),
			),
		).toBe(true);
		expect(
			manifest.replicant.score.permission.canWrite(human(ADMIN_ROLE.admin)),
		).toBe(true);
	});

	test("an anonymous caller passes only where anonymous is allowed", () => {
		expect(manifest.replicant.score.permission.canRead(anonymous)).toBe(false);
		expect(manifest.replicant.open.permission.canRead(anonymous)).toBe(true);
	});

	test("a machine with no roles matches nothing", () => {
		expect(manifest.replicant.score.permission.canRead(machine())).toBe(false);
	});

	test("a machine's assigned roles are enforced like a human's", () => {
		expect(
			manifest.replicant.score.permission.canRead(machine(RoleName("viewer"))),
		).toBe(true);
		expect(
			manifest.replicant.score.permission.canWrite(machine(RoleName("viewer"))),
		).toBe(false);
		expect(
			manifest.replicant.score.permission.canWrite(machine(RoleName("judge"))),
		).toBe(true);
	});

	test("computed fields are never writable, not even for an admin", () => {
		expect(
			manifest.computed.total.permission.canRead(human(RoleName("viewer"))),
		).toBe(true);
		expect(
			manifest.computed.total.permission.canWrite(human(ADMIN_ROLE.superadmin)),
		).toBe(false);
	});

	test("a server identity holds every capability by default", () => {
		expect(manifest.replicant.score.permission.canWrite(server)).toBe(true);
		expect(manifest.computed.total.permission.canRead(server)).toBe(true);
	});

	test("an allow narrows the named roles without revoking the server or the admin", () => {
		expect(manifest.replicant.score.permission.canWrite(server)).toBe(true);
		expect(manifest.replicant.config.permission.canWrite(server)).toBe(true);
		expect(
			manifest.replicant.config.permission.canWrite(human(ADMIN_ROLE.admin)),
		).toBe(true);
		expect(
			manifest.replicant.config.permission.canWrite(human(RoleName("judge"))),
		).toBe(false);
	});

	test("a client grant admits any declared role, including one added by a later extend", () => {
		const members = defineNamespace("match", {
			roles: { judge: { permission: [] } },
			replicant: {
				lounge: {
					schema: Schema.Number,
					permission: { read: { client: "allow" } },
				},
			},
		});

		expect(
			members.replicant.lounge.permission.canRead(human(RoleName("judge"))),
		).toBe(true);
		expect(members.replicant.lounge.permission.canRead(anonymous)).toBe(false);

		const extended = extendNamespace(members, {
			roles: { auditor: { permission: [] } },
		});
		expect(
			extended.replicant.lounge.permission.canRead(human(RoleName("auditor"))),
		).toBe(true);
	});
});

describe("principals as capability bases", () => {
	const based = defineNamespace("match", {
		principals: { everyone: { permission: ["computed-read"] } },
		roles: { judge: { permission: ["replicant-read"] } },
		replicant: { score: { schema: Schema.Number } },
		computed: { total: { schema: Schema.Number } },
	});

	test("an everyone base admits every caller without a field rule", () => {
		expect(based.computed.total.permission.canRead(anonymous)).toBe(true);
		expect(
			based.computed.total.permission.canRead(human(RoleName("judge"))),
		).toBe(true);
	});

	test("an everyone base on one capability does not leak into another", () => {
		expect(based.replicant.score.permission.canRead(anonymous)).toBe(false);
	});
});

describe("admin and server are undeniable", () => {
	test("a permission rule cannot target them", () => {
		for (const principal of ["admin", "server"]) {
			const permission = { write: { [principal]: "deny" } };
			expect(() =>
				defineNamespace("match", {
					replicant: { audit: { schema: Schema.Number, permission } },
				}),
			).toThrow(
				new RegExp(`Undeniable principal "${principal}" in replicant "audit"`),
			);
		}
	});

	test("their capability bases cannot be overridden", () => {
		for (const principal of ["admin", "server"]) {
			const principals = { [principal]: { permission: [] } };
			expect(() =>
				defineNamespace("match", {
					principals,
					replicant: { score: { schema: Schema.Number } },
				}),
			).toThrow(new RegExp(`Principal "${principal}" is undeniable`));
		}
	});
});

describe("deny beats a wildcard grant", () => {
	const wildcard = defineNamespace("match", {
		roles: { viewer: { permission: [] } },
		replicant: {
			open: {
				schema: Schema.Number,
				permission: { read: { everyone: "allow" } },
			},
			hidden: {
				schema: Schema.Number,
				permission: { read: { everyone: "allow", deny: ["viewer"] } },
			},
		},
	});

	test("an explicit deny excludes a caller the wildcard would have admitted", () => {
		expect(
			wildcard.replicant.open.permission.canRead(human(RoleName("viewer"))),
		).toBe(true);
		expect(
			wildcard.replicant.hidden.permission.canRead(human(RoleName("viewer"))),
		).toBe(false);
		expect(wildcard.replicant.hidden.permission.canRead(anonymous)).toBe(true);
	});

	test("denying everyone seals the field against every wire caller except the admin", () => {
		const sealed = defineNamespace("match", {
			roles: { viewer: { permission: ["replicant-read"] } },
			replicant: {
				audit: {
					schema: Schema.Number,
					permission: { read: { everyone: "deny" } },
				},
			},
		});

		expect(sealed.replicant.audit.permission.canRead(anonymous)).toBe(false);
		expect(
			sealed.replicant.audit.permission.canRead(human(RoleName("viewer"))),
		).toBe(false);
		expect(
			sealed.replicant.audit.permission.canRead(human(ADMIN_ROLE.admin)),
		).toBe(true);
		expect(sealed.replicant.audit.permission.canRead(server)).toBe(true);
	});
});

describe("isAdminTier", () => {
	test("holds for superadmin and admin", () => {
		expect(isAdminTier(human(ADMIN_ROLE.superadmin))).toBe(true);
		expect(isAdminTier(human(ADMIN_ROLE.admin))).toBe(true);
	});

	test("fails for a named role, anonymous, and server", () => {
		expect(isAdminTier(human(RoleName("judge")))).toBe(false);
		expect(isAdminTier(anonymous)).toBe(false);
		expect(isAdminTier(server)).toBe(false);
	});
});

describe("getRolesFromIdentity", () => {
	test("projects the held roles of a human and a machine", () => {
		expect(getRolesFromIdentity(human(RoleName("judge")))).toEqual(
			new Set([RoleName("judge")]),
		);
		expect(getRolesFromIdentity(machine(RoleName("viewer")))).toEqual(
			new Set([RoleName("viewer")]),
		);
	});

	test("is empty for anonymous and server", () => {
		expect(getRolesFromIdentity(anonymous)).toEqual(new Set());
		expect(getRolesFromIdentity(server)).toEqual(new Set());
	});
});

describe("declaredRoleNames", () => {
	test("returns every declared role, capability-less ones included", () => {
		const declared = defineNamespace("declared", {
			roles: {
				producer: { permission: ["replicant-write"] },
				idle: { permission: [] },
			},
		});
		expect(declaredRoleNames(declared)).toEqual(
			new Set([RoleName("producer"), RoleName("idle")]),
		);
	});

	test("includes roles a later extend adds", () => {
		const base = defineNamespace("base", {
			roles: { producer: { permission: ["replicant-write"] } },
		});
		const extended = extendNamespace(base, {
			roles: { moderator: { permission: [] } },
		});
		expect(declaredRoleNames(extended)).toEqual(
			new Set([RoleName("producer"), RoleName("moderator")]),
		);
	});
});
