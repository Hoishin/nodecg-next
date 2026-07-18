import { IdentitySchema, RoleName } from "@nodecg/internal";
import { Schema } from "effect";
import { assert, describe, expect, test } from "vitest";

import {
	assignRole,
	grantAsAdmin,
	login,
	logout,
	revokeAsAdmin,
} from "../../src/client/auth.ts";

const MeSchema = Schema.Struct({ identity: IdentitySchema });
const decodeMe = Schema.decodeUnknownSync(MeSchema);

const fetchMe = async (init?: RequestInit) =>
	decodeMe(await (await fetch("/api/internal/me", init)).json());

describe("anonymous identity", () => {
	test("a request without a session resolves to the anonymous identity", async () => {
		expect((await fetchMe()).identity).toEqual({ _tag: "anonymous" });
	});
});

describe("browser login", () => {
	test("logging in establishes a session, logout tears it down", async () => {
		await login("alice");

		expect((await fetchMe()).identity).toEqual({
			_tag: "human",
			account: { issuer: "dev", subject: "alice", displayName: "Alice" },
			roles: new Set(),
		});

		await logout();
		expect((await fetchMe()).identity).toEqual({ _tag: "anonymous" });
	});
});

describe("runtime role assignment", () => {
	test("a granted role rides on the resolved identity live, and revoke removes it", async () => {
		await login("operator");
		const before = (await fetchMe()).identity;
		assert(before._tag === "human");
		expect(before.roles).toEqual(new Set());

		await grantAsAdmin("operator", "producer");
		await login("operator");
		const granted = (await fetchMe()).identity;
		assert(granted._tag === "human");
		expect(granted.roles).toEqual(new Set([RoleName("producer")]));

		await revokeAsAdmin("operator", "producer");
		await login("operator");
		const revoked = (await fetchMe()).identity;
		assert(revoked._tag === "human");
		expect(revoked.roles).toEqual(new Set());

		await logout();
	});

	test("even an admin cannot grant an undeclarable role (403)", async () => {
		await login("root");
		expect((await assignRole("grant", "operator", "server")).status).toBe(403);
		expect((await assignRole("grant", "operator", "superadmin")).status).toBe(
			403,
		);
		await logout();
	});

	test("a caller without the admin tier cannot grant (403)", async () => {
		await login("nobody");
		expect((await assignRole("grant", "nobody", "superadmin")).status).toBe(
			403,
		);
		await logout();
	});

	test("an anonymous caller cannot grant (403)", async () => {
		await logout();
		expect((await assignRole("grant", "nobody", "superadmin")).status).toBe(
			403,
		);
	});
});
