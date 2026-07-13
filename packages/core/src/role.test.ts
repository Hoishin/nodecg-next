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

import { defineNamespace } from "./define-namespace.ts";
import { isAdminTier } from "./role.ts";

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
			permission: { read: { allow: ["everyone"] } },
		},
		config: {
			schema: Schema.String,
			permission: { write: { allow: ["server"] } },
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

	test("a server identity matches only server-owned fields", () => {
		expect(manifest.replicant.config.permission.canWrite(server)).toBe(true);
		expect(
			manifest.replicant.config.permission.canWrite(human(RoleName("judge"))),
		).toBe(false);
		expect(manifest.replicant.score.permission.canWrite(server)).toBe(false);
	});
});

describe("principals as capability bases", () => {
	const based = defineNamespace("match", {
		principals: {
			everyone: { permission: ["computed-read"] },
			server: { permission: ["replicant-write"] },
		},
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

	test("a server base admits the server identity but not a named role", () => {
		expect(based.replicant.score.permission.canWrite(server)).toBe(true);
		expect(
			based.replicant.score.permission.canWrite(human(RoleName("judge"))),
		).toBe(false);
	});

	test("an everyone base on one capability does not leak into another", () => {
		expect(based.replicant.score.permission.canRead(anonymous)).toBe(false);
	});
});

describe("overriding the admin principal", () => {
	const narrowed = defineNamespace("match", {
		principals: { admin: { permission: ["replicant-read"] } },
		roles: { judge: { permission: ["replicant-read", "replicant-write"] } },
		replicant: { score: { schema: Schema.Number } },
	});

	test("narrows the admin to the declared capabilities", () => {
		expect(
			narrowed.replicant.score.permission.canRead(human(ADMIN_ROLE.admin)),
		).toBe(true);
		expect(
			narrowed.replicant.score.permission.canWrite(human(ADMIN_ROLE.admin)),
		).toBe(false);
	});

	test("narrows a superadmin with it — holding superadmin means having the admin principal", () => {
		expect(
			narrowed.replicant.score.permission.canRead(human(ADMIN_ROLE.superadmin)),
		).toBe(true);
		expect(
			narrowed.replicant.score.permission.canWrite(
				human(ADMIN_ROLE.superadmin),
			),
		).toBe(false);
	});

	test("deny locks a single field against the admin, superadmin included", () => {
		const sealed = defineNamespace("match", {
			replicant: {
				audit: {
					schema: Schema.Number,
					permission: { read: { deny: ["admin"] } },
				},
			},
		});

		expect(
			sealed.replicant.audit.permission.canRead(human(ADMIN_ROLE.admin)),
		).toBe(false);
		expect(
			sealed.replicant.audit.permission.canRead(human(ADMIN_ROLE.superadmin)),
		).toBe(false);
	});

	test("an explicit allow still grants an admin whose base was emptied", () => {
		const pinned = defineNamespace("match", {
			principals: { admin: { permission: [] } },
			replicant: {
				audit: {
					schema: Schema.Number,
					permission: { write: { allow: ["admin"] } },
				},
			},
		});

		expect(
			pinned.replicant.audit.permission.canWrite(human(ADMIN_ROLE.admin)),
		).toBe(true);
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
