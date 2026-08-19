import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { makeAuthHelpers } from "../../src/client/auth.ts";
import { suiteBase } from "../../src/client/suite-base.ts";

const base = suiteBase("machine-auth");
const { login, logout } = makeAuthHelpers(base);

const CreatedMachineSchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	token: Schema.String,
});
const decodeCreatedMachine = Schema.decodeUnknownSync(CreatedMachineSchema);

const provisionMachine = async (displayName: string) => {
	await login("root");
	const response = await fetch(`${base}/api/internal/machines`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName }),
	});
	const machine = decodeCreatedMachine(await response.json());
	await logout();
	return machine;
};

const revokeMachine = async (id: string) => {
	await login("root");
	const response = await fetch(`${base}/api/internal/machines/${id}`, {
		method: "DELETE",
	});
	await logout();
	return response;
};

const grantMachineRole = async (id: string, role: string) => {
	await login("root");
	const response = await fetch(`${base}/api/internal/machines/${id}/roles`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ role }),
	});
	await logout();
	return response;
};

const readV0 = (fieldName: string, token?: string) =>
	fetch(`${base}/api/v0/namespaces/e2e/replicant/${fieldName}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});

const writeV0 = (fieldName: string, token: string, patch: unknown) =>
	fetch(`${base}/api/v0/namespaces/e2e/replicant/${fieldName}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(patch),
	});

describe("public /api/v0 bearer authentication", () => {
	test("a request without a bearer token is rejected", async () => {
		expect((await readV0("count")).status).toBe(401);
	});

	test("an unknown bearer token is rejected", async () => {
		expect((await readV0("count", "ncg_unknown-token")).status).toBe(401);
	});

	test("a provisioned key reads an unrestricted field", async () => {
		const { token } = await provisionMachine("reader-bot");
		const response = await readV0("count", token);
		expect(response.status).toBe(200);
		expect(typeof (await response.json())).toBe("number");
	});

	test("an authenticated machine without roles is forbidden from a restricted field", async () => {
		const { token } = await provisionMachine("nosy-bot");
		expect((await readV0("secret", token)).status).toBe(403);
	});

	test("a granted role opens the fields it gates, and only those", async () => {
		const { id, token } = await provisionMachine("promoted-bot");
		expect((await readV0("producerOnly", token)).status).toBe(403);

		const grant = await grantMachineRole(id, "producer");
		expect(grant.status).toBe(200);
		expect(await grant.json()).toEqual({ roles: ["producer"] });

		const read = await readV0("producerOnly", token);
		expect(read.status).toBe(200);
		expect(await read.json()).toBe("producers-only");

		expect((await readV0("secret", token)).status).toBe(403);
	});

	test("a revoked key stops authenticating", async () => {
		const { id, token } = await provisionMachine("throwaway-bot");
		expect((await readV0("count", token)).status).toBe(200);

		expect((await revokeMachine(id)).status).toBe(204);

		expect((await readV0("count", token)).status).toBe(401);
	});
});

describe("hand-written patches with test preconditions", () => {
	test("a matching test commits, the same patch replayed answers 409", async () => {
		const { token } = await provisionMachine("patch-bot");
		const patch = [
			{ op: "test", path: "/home", value: 0 },
			{ op: "replace", path: "/home", value: 5 },
		];

		const write = await writeV0("scoreboard", token, patch);
		expect(write.status).toBe(204);
		expect(await (await readV0("scoreboard", token)).json()).toEqual({
			home: 5,
			away: 0,
		});

		const replay = await writeV0("scoreboard", token, patch);
		expect(replay.status).toBe(409);
		expect(await replay.json()).toEqual({
			_tag: "RevisionConflict",
			value: { home: 5, away: 0 },
			revision: 1,
			reason: "ValueMismatch",
		});
	});
});
