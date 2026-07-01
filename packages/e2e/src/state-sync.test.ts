import { loadNamespace } from "@nodecg/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { extendedManifest, fixtureManifest } from "./fixture-state.ts";

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

// Assign the roles the field-access tests rely on once, so those tests just log
// in as the subject. Grant/revoke behavior itself is covered in auth.test.ts.
beforeAll(async () => {
	await grantAsAdmin("prod", "producer");
	await grantAsAdmin("view", "viewer");
});
afterAll(async () => {
	await revokeAsAdmin("prod", "producer");
	await revokeAsAdmin("view", "viewer");
	await logout();
});

describe("anonymous access", () => {
	beforeAll(async () => {
		await logout();
	});

	test("a read of a restricted field is denied (HTTP 403)", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await expect(ns.state.secret.get()).rejects.toThrow(/Permission denied/);
	});

	test("a subscribe to a restricted field is rejected (WS forbidden)", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await expect(ns.state.secret.subscribe(() => {})).rejects.toThrow(
			/Permission denied/,
		);
	});
});

describe("client ⇄ server state sync (as producer)", () => {
	beforeAll(async () => {
		await login("prod");
	});

	test("reads the server-seeded value", async () => {
		const ns = await loadNamespace(fixtureManifest);
		expect(await ns.state.count.get()).toBe(0);
		expect(await ns.state.label.get()).toBe("hello");
	});

	test("set round-trips through the server", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await ns.state.count.set(42);
		expect(await ns.state.count.get()).toBe(42);
	});

	test("subscribe receives the current value, then published updates", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await ns.state.count.set(5);
		const received: number[] = [];
		const cancel = await ns.state.count.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual([5]));
		await ns.state.count.set(7);
		await vi.waitFor(() => expect(received).toEqual([5, 7]));
		await cancel();
	});

	test("reads a server-computed value over HTTP", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await ns.state.count.set(10);
		expect(await ns.computed.doubledCount.get()).toBe(20);
	});

	test("subscribe to a computed value receives recomputed updates", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await ns.state.count.set(3);
		const received: number[] = [];
		const cancel = await ns.computed.doubledCount.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.at(-1)).toBe(6));
		await ns.state.count.set(4);
		await vi.waitFor(() => expect(received.at(-1)).toBe(8));
		await cancel();
	});

	test("a branching computed dedupes source changes it doesn't depend on", async () => {
		const ns = await loadNamespace(fixtureManifest);
		await ns.state.count.set(0);
		await ns.state.label.set("first");
		const received: string[] = [];
		const cancel = await ns.computed.summary.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual(["idle"]));
		await ns.state.label.set("second");
		await ns.state.count.set(3);
		await vi.waitFor(() => expect(received).toEqual(["idle", "second x3"]));
		await cancel();
	});
});

describe("namespace frontend serving", () => {
	test("serves the namespace's index", async () => {
		const response = await fetch("/frontend/namespaces/e2e/");
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("hello from the frontend");
	});

	test("serves a file under the namespace", async () => {
		const response = await fetch("/frontend/namespaces/e2e/app.js");
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("frontend module loaded");
	});

	test("404s for an unknown namespace", async () => {
		const response = await fetch("/frontend/namespaces/unknown/index.html");
		expect(response.status).toBe(404);
	});

	test("404s for a missing file in a known namespace", async () => {
		const response = await fetch("/frontend/namespaces/e2e/missing.js");
		expect(response.status).toBe(404);
	});
});

describe("extended namespace sync (as producer)", () => {
	beforeAll(async () => {
		await login("prod");
	});

	test("reads original + added state and a computed over both", async () => {
		const ns = await loadNamespace(extendedManifest);
		await ns.state.score.set(4);
		await ns.state.bonus.set(3);
		expect(await ns.state.score.get()).toBe(4);
		expect(await ns.state.bonus.get()).toBe(3);
		expect(await ns.computed.total.get()).toBe(7);
	});

	test("the extend-added computed recomputes when the original state changes", async () => {
		const ns = await loadNamespace(extendedManifest);
		await ns.state.score.set(1);
		await ns.state.bonus.set(0);
		const received: number[] = [];
		const cancel = await ns.computed.total.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.at(-1)).toBe(1));
		await ns.state.score.set(10);
		await vi.waitFor(() => expect(received.at(-1)).toBe(10));
		await cancel();
	});
});

describe("role-gated field access (HTTP)", () => {
	test("anonymous is denied the role-gated and the client-gated field", async () => {
		await logout();
		const ns = await loadNamespace(fixtureManifest);
		await expect(ns.state.producerOnly.get()).rejects.toThrow(
			/Permission denied/,
		);
		await expect(ns.state.membersOnly.get()).rejects.toThrow(
			/Permission denied/,
		);
	});

	test("an explicit producer reads the producer-only and client fields", async () => {
		await login("prod");
		const ns = await loadNamespace(fixtureManifest);
		expect(await ns.state.producerOnly.get()).toBe("producers-only");
		expect(await ns.state.membersOnly.get()).toBe("members-only");
	});

	test("a viewer reads the client field via the umbrella but not the producer-only field", async () => {
		await login("view");
		const ns = await loadNamespace(fixtureManifest);
		expect(await ns.state.membersOnly.get()).toBe("members-only");
		await expect(ns.state.producerOnly.get()).rejects.toThrow(
			/Permission denied/,
		);
	});
});

describe("WS handshake honors the session cookie", () => {
	test("a logged-in producer subscribes to a producer-only field", async () => {
		await login("prod");
		const ns = await loadNamespace(fixtureManifest);
		const received: string[] = [];
		const cancel = await ns.state.producerOnly.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual(["producers-only"]));
		await cancel();
	});
});
