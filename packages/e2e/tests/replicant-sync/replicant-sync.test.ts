import { loadNamespace } from "@nodecg/client";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	onTestFinished,
	test,
	vi,
} from "vitest";

import { makeAuthHelpers } from "../../src/client/auth.ts";
import { suiteBase } from "../../src/client/suite-base.ts";
import {
	extendedManifest,
	fixtureManifest,
} from "../../src/shared/manifests.ts";

const base = suiteBase("replicant-sync");
const { grantAsAdmin, login, logout, revokeAsAdmin } = makeAuthHelpers(base);

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
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await expect(ns.replicant.secret.get()).rejects.toThrow(
			/Permission denied/,
		);
	});

	test("a subscribe to a restricted field is rejected (WS forbidden)", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await expect(ns.replicant.secret.subscribe(() => {})).rejects.toThrow(
			/Permission denied/,
		);
	});
});

describe("client ⇄ server replicant sync (as producer)", () => {
	beforeAll(async () => {
		await login("prod");
	});

	test("reads the server-seeded value", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		expect(await ns.replicant.count.get()).toBe(0);
		expect(await ns.replicant.label.get()).toBe("hello");
	});

	test("set round-trips through the server", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await ns.replicant.count.set(42);
		expect(await ns.replicant.count.get()).toBe(42);
	});

	test("subscribe receives the current value, then published updates", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await ns.replicant.count.set(5);
		const received: number[] = [];
		const cancel = await ns.replicant.count.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual([5]));
		await ns.replicant.count.set(7);
		await vi.waitFor(() => expect(received).toEqual([5, 7]));
		await cancel();
	});

	test("reads a server-computed value over HTTP", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await ns.replicant.count.set(10);
		expect(await ns.computed.doubledCount.get()).toBe(20);
	});

	test("subscribe to a computed value receives recomputed updates", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await ns.replicant.count.set(3);
		const received: number[] = [];
		const cancel = await ns.computed.doubledCount.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.at(-1)).toBe(6));
		await ns.replicant.count.set(4);
		await vi.waitFor(() => expect(received.at(-1)).toBe(8));
		await cancel();
	});

	test("a branching computed dedupes source changes it doesn't depend on", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await ns.replicant.count.set(0);
		await ns.replicant.label.set("first");
		const received: string[] = [];
		const cancel = await ns.computed.summary.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual(["idle"]));
		await ns.replicant.label.set("second");
		await ns.replicant.count.set(3);
		await vi.waitFor(() => expect(received).toEqual(["idle", "second x3"]));
		await cancel();
	});
});

describe("namespace frontend serving", () => {
	test("serves the namespace's index", async () => {
		const response = await fetch(`${base}/frontend/namespaces/e2e/`);
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("hello from the frontend");
	});

	test("serves a file under the namespace", async () => {
		const response = await fetch(`${base}/frontend/namespaces/e2e/app.js`);
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("frontend module loaded");
	});

	test("404s for an unknown namespace", async () => {
		const response = await fetch(
			`${base}/frontend/namespaces/unknown/index.html`,
		);
		expect(response.status).toBe(404);
	});

	test("404s for a missing file in a known namespace", async () => {
		const response = await fetch(`${base}/frontend/namespaces/e2e/missing.js`);
		expect(response.status).toBe(404);
	});
});

describe("extended namespace frontend serving (spa)", () => {
	test("serves the index from the base dir", async () => {
		const response = await fetch(`${base}/frontend/namespaces/e2e-extend/`);
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("spa shell");
	});

	test("serves a file from the extension's appended dir", async () => {
		const response = await fetch(
			`${base}/frontend/namespaces/e2e-extend/widget.js`,
		);
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("extension widget loaded");
	});

	test("falls back to the base index for a client-side route", async () => {
		const response = await fetch(
			`${base}/frontend/namespaces/e2e-extend/some/route`,
		);
		expect(response.ok).toBe(true);
		expect(await response.text()).toContain("spa shell");
	});

	test("404s for a missing file despite the fallback", async () => {
		const response = await fetch(
			`${base}/frontend/namespaces/e2e-extend/missing.js`,
		);
		expect(response.status).toBe(404);
	});
});

describe("extended namespace sync (as producer)", () => {
	beforeAll(async () => {
		await login("prod");
	});

	test("reads original + added replicant and a computed over both", async () => {
		const ns = await loadNamespace(extendedManifest, { baseUrl: base });
		await ns.replicant.score.set(4);
		await ns.replicant.bonus.set(3);
		expect(await ns.replicant.score.get()).toBe(4);
		expect(await ns.replicant.bonus.get()).toBe(3);
		expect(await ns.computed.total.get()).toBe(7);
	});

	test("the extend-added computed recomputes when the original replicant changes", async () => {
		const ns = await loadNamespace(extendedManifest, { baseUrl: base });
		await ns.replicant.score.set(1);
		await ns.replicant.bonus.set(0);
		const received: number[] = [];
		const cancel = await ns.computed.total.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.at(-1)).toBe(1));
		await ns.replicant.score.set(10);
		await vi.waitFor(() => expect(received.at(-1)).toBe(10));
		await cancel();
	});
});

describe("role-gated field access (HTTP)", () => {
	test("anonymous is denied the role-gated and the client-gated field", async () => {
		await logout();
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		await expect(ns.replicant.producerOnly.get()).rejects.toThrow(
			/Permission denied/,
		);
		await expect(ns.replicant.membersOnly.get()).rejects.toThrow(
			/Permission denied/,
		);
	});

	test("an explicit producer reads the producer-only and client fields", async () => {
		await login("prod");
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		expect(await ns.replicant.producerOnly.get()).toBe("producers-only");
		expect(await ns.replicant.membersOnly.get()).toBe("members-only");
	});

	test("a viewer reads the client field via the umbrella but not the producer-only field", async () => {
		await login("view");
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		expect(await ns.replicant.membersOnly.get()).toBe("members-only");
		await expect(ns.replicant.producerOnly.get()).rejects.toThrow(
			/Permission denied/,
		);
	});
});

describe("WS handshake honors the session cookie", () => {
	test("a logged-in producer subscribes to a producer-only field", async () => {
		await login("prod");
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		const received: string[] = [];
		const cancel = await ns.replicant.producerOnly.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual(["producers-only"]));
		await cancel();
	});
});

describe("messaging (topic + rpc)", () => {
	beforeAll(async () => {
		await logout();
	});

	test("a topic publish fans out to a separate subscriber", async () => {
		const subscriber = await loadNamespace(fixtureManifest, { baseUrl: base });
		const publisher = await loadNamespace(fixtureManifest, { baseUrl: base });
		const received: string[] = [];
		const cancel = await subscriber.topic.chat.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(
			async () => {
				await publisher.topic.chat.publish("hello");
				expect(received).toContain("hello");
			},
			{ timeout: 5000, interval: 100 },
		);
		await cancel();
	});

	test("a second subscriber on the same client joins live without replaying the last event", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		const publisher = await loadNamespace(fixtureManifest, { baseUrl: base });
		const first: string[] = [];
		const cancelFirst = await ns.topic.chat.subscribe((value) => {
			first.push(value);
		});
		onTestFinished(() => cancelFirst());
		await vi.waitFor(
			async () => {
				await publisher.topic.chat.publish("seed");
				expect(first).toContain("seed");
			},
			{ timeout: 5000, interval: 100 },
		);
		await publisher.topic.chat.publish("sync");
		await vi.waitFor(() => expect(first).toContain("sync"));

		const second: string[] = [];
		const cancelSecond = await ns.topic.chat.subscribe((value) => {
			second.push(value);
		});
		onTestFinished(() => cancelSecond());
		await vi.waitFor(
			async () => {
				await publisher.topic.chat.publish("live");
				expect(second).toContain("live");
			},
			{ timeout: 5000, interval: 100 },
		);

		expect(second).not.toContain("seed");
		expect(second).not.toContain("sync");
		expect(first).toContain("live");
	});

	test("an rpc call runs the server handler and returns its response", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		expect(await ns.rpc.echo.call("ping")).toBe("PING");
	});

	test("an rpc handler mutates a replicant that a subscriber observes", async () => {
		const ns = await loadNamespace(fixtureManifest, { baseUrl: base });
		const received: number[] = [];
		const cancel = await ns.replicant.count.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
		const returned = await ns.rpc.bump.call(5);
		await vi.waitFor(() => expect(received).toContain(returned));
		await cancel();
	});
});
