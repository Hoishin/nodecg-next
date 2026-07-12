import {
	HumanAccountSchema,
	HumanIdentitySchema,
	MachineIdentitySchema,
	AnonymousIdentitySchema,
	RESERVED_ROLE,
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

	test("superadmin and admin bypass every field set", () => {
		expect(
			manifest.replicant.score.permission.canWrite(
				human(RESERVED_ROLE.superadmin),
			),
		).toBe(true);
		expect(
			manifest.replicant.score.permission.canWrite(human(RESERVED_ROLE.admin)),
		).toBe(true);
	});

	test("an anonymous caller passes only where anonymous is allowed", () => {
		expect(manifest.replicant.score.permission.canRead(anonymous)).toBe(false);
		expect(manifest.replicant.open.permission.canRead(anonymous)).toBe(true);
	});

	test("a machine identity carries no roles", () => {
		const machine = MachineIdentitySchema.make({
			id: "robot",
			displayName: "Bot",
		});
		expect(manifest.replicant.score.permission.canRead(machine)).toBe(false);
	});

	test("computed fields are never writable, even for superadmin", () => {
		expect(
			manifest.computed.total.permission.canRead(human(RoleName("viewer"))),
		).toBe(true);
		expect(
			manifest.computed.total.permission.canWrite(
				human(RESERVED_ROLE.superadmin),
			),
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

describe("isAdminTier", () => {
	test("holds for superadmin and admin", () => {
		expect(isAdminTier(human(RESERVED_ROLE.superadmin))).toBe(true);
		expect(isAdminTier(human(RESERVED_ROLE.admin))).toBe(true);
	});

	test("fails for a named role, anonymous, and server", () => {
		expect(isAdminTier(human(RoleName("judge")))).toBe(false);
		expect(isAdminTier(anonymous)).toBe(false);
		expect(isAdminTier(server)).toBe(false);
	});
});
