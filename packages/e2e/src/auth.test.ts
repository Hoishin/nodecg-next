import { IdentitySchema, RESERVED_ROLE } from "@nodecg/internal";
import { Schema } from "effect";
import { assert, describe, expect, test } from "vitest";

const MeSchema = Schema.Struct({ identity: IdentitySchema });
const decodeMe = Schema.decodeUnknownSync(MeSchema);

const fetchMe = async (init?: RequestInit) =>
	decodeMe(await (await fetch("/api/me", init)).json());

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

describe("anonymous identity", () => {
	test("a request without a session resolves to the public identity", async () => {
		expect((await fetchMe()).identity).toEqual({ _tag: "public" });
	});
});

describe("browser login", () => {
	test("logging in establishes a session, logout tears it down", async () => {
		await fetch("/api/authentication/login/dev?as=alice", { method: "POST" });

		expect((await fetchMe()).identity).toEqual({
			_tag: "human",
			account: { issuer: "dev", subject: "alice", displayName: "Alice" },
			roles: new Set(),
		});

		await fetch("/api/authentication/logout", { method: "POST" });
		expect((await fetchMe()).identity).toEqual({ _tag: "public" });
	});
});

describe("runtime role assignment", () => {
	test("a granted role rides on the resolved identity live, and revoke removes it", async () => {
		await fetch("/api/authentication/login/dev?as=operator", {
			method: "POST",
		});

		const before = (await fetchMe()).identity;
		assert(before._tag === "human");
		expect(before.roles).toEqual(new Set());

		await assignRole("grant", "operator", "superadmin");

		const granted = (await fetchMe()).identity;
		assert(granted._tag === "human");
		expect(granted.roles).toEqual(new Set([RESERVED_ROLE.superadmin]));

		await assignRole("revoke", "operator", "superadmin");

		const revoked = (await fetchMe()).identity;
		assert(revoked._tag === "human");
		expect(revoked.roles).toEqual(new Set());

		await fetch("/api/authentication/logout", { method: "POST" });
	});
});
