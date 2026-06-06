import { loadNamespace } from "@nodecg/client";
import { describe, expect, test, vi } from "vitest";

import { fixtureManifest } from "./fixture-state.ts";

describe("client ⇄ server state sync", () => {
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
		cancel();
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
		cancel();
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
		cancel();
	});
});
