import { IdentitySchema, RESERVED_ROLE } from "@nodecg/internal";
import { Schema } from "effect";
import { assert, describe, expect, test } from "vitest";

const MeSchema = Schema.Struct({ identity: IdentitySchema });
const decodeMe = Schema.decodeUnknownSync(MeSchema);

const fetchMe = async (init?: RequestInit) =>
	decodeMe(await (await fetch("/api/me", init)).json());

const login = (subject: string) =>
	fetch(`/api/authentication/login/dev?as=${subject}`, { method: "POST" });
const logout = () => fetch("/api/authentication/logout", { method: "POST" });
const assignRole = (
	action: "grant" | "revoke",
	subject: string,
	role: string,
) =>
	fetch(`/api/roles/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ issuer: "dev", subject, role }),
	});

const grantAsAdmin = async (subject: string, role: string) => {
	await login("root");
	await assignRole("grant", subject, role);
};
const revokeAsAdmin = async (subject: string, role: string) => {
	await login("root");
	await assignRole("revoke", subject, role);
};

describe("anonymous identity", () => {
	test("a request without a session resolves to the public identity", async () => {
		expect((await fetchMe()).identity).toEqual({ _tag: "public" });
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
		expect((await fetchMe()).identity).toEqual({ _tag: "public" });
	});
});

describe("runtime role assignment", () => {
	test("a granted role rides on the resolved identity live, and revoke removes it", async () => {
		await login("operator");
		const before = (await fetchMe()).identity;
		assert(before._tag === "human");
		expect(before.roles).toEqual(new Set());

		await grantAsAdmin("operator", "superadmin");
		await login("operator");
		const granted = (await fetchMe()).identity;
		assert(granted._tag === "human");
		expect(granted.roles).toEqual(new Set([RESERVED_ROLE.superadmin]));

		await revokeAsAdmin("operator", "superadmin");
		await login("operator");
		const revoked = (await fetchMe()).identity;
		assert(revoked._tag === "human");
		expect(revoked.roles).toEqual(new Set());

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
