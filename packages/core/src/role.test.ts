import {
	HumanAccountSchema,
	HumanIdentitySchema,
	MachineIdentitySchema,
	PublicIdentitySchema,
	RESERVED_ROLE,
	RoleName,
	ServerIdentitySchema,
} from "@nodecg/internal";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { defineNamespace } from "./define-namespace.ts";

const human = (...roles: RoleName[]) =>
	HumanIdentitySchema.make({
		account: HumanAccountSchema.make({
			issuer: "test",
			subject: "subject",
			displayName: "Tester",
		}),
		roles: new Set(roles),
	});
const anonymous = PublicIdentitySchema.make();
const server = ServerIdentitySchema.make();

const manifest = defineNamespace("match", {
	roles: {
		judge: { permission: ["state-read", "state-write", "computed-read"] },
		viewer: { permission: ["state-read", "computed-read"] },
	},
	state: {
		score: {
			schema: Schema.Number,
			permission: { write: { allow: ["judge"] } },
		},
		open: {
			schema: Schema.Number,
			permission: { read: { allow: ["public"] } },
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
			manifest.state.score.permission.canRead(human(RoleName("viewer"))),
		).toBe(true);
		expect(
			manifest.state.score.permission.canWrite(human(RoleName("viewer"))),
		).toBe(false);
		expect(
			manifest.state.score.permission.canWrite(human(RoleName("judge"))),
		).toBe(true);
	});

	test("superadmin and admin bypass every field set", () => {
		expect(
			manifest.state.score.permission.canWrite(human(RESERVED_ROLE.superadmin)),
		).toBe(true);
		expect(
			manifest.state.score.permission.canWrite(human(RESERVED_ROLE.admin)),
		).toBe(true);
	});

	test("an anonymous caller passes only where public is allowed", () => {
		expect(manifest.state.score.permission.canRead(anonymous)).toBe(false);
		expect(manifest.state.open.permission.canRead(anonymous)).toBe(true);
	});

	test("a machine identity carries no roles", () => {
		const machine = MachineIdentitySchema.make({
			id: "robot",
			displayName: "Bot",
		});
		expect(manifest.state.score.permission.canRead(machine)).toBe(false);
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
		expect(manifest.state.config.permission.canWrite(server)).toBe(true);
		expect(
			manifest.state.config.permission.canWrite(human(RoleName("judge"))),
		).toBe(false);
		expect(manifest.state.score.permission.canWrite(server)).toBe(false);
	});
});
