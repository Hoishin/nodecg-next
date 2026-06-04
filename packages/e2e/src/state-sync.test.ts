import { loadState } from "@nodecg/client";
import { describe, expect, test, vi } from "vitest";

import { fixtureManifest } from "./fixture-state.ts";

describe("client ⇄ server state sync", () => {
	test("reads the server-seeded value", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		expect(await state.count.get()).toBe(0);
		expect(await state.label.get()).toBe("hello");
	});

	test("set round-trips through the server", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		await state.count.set(42);
		expect(await state.count.get()).toBe(42);
	});

	test("subscribe receives the current value, then published updates", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		await state.count.set(5);
		const received: number[] = [];
		const cancel = await state.count.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual([5]));
		await state.count.set(7);
		await vi.waitFor(() => expect(received).toEqual([5, 7]));
		cancel();
	});

	test("reads a server-computed value over HTTP", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		await state.count.set(10);
		expect(await state.doubledCount.get()).toBe(20);
	});

	test("subscribe to a computed value receives recomputed updates", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		await state.count.set(3);
		const received: number[] = [];
		const cancel = await state.doubledCount.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received.at(-1)).toBe(6));
		await state.count.set(4);
		await vi.waitFor(() => expect(received.at(-1)).toBe(8));
		cancel();
	});

	test("a branching computed dedupes source changes it doesn't depend on", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		await state.count.set(0);
		await state.label.set("first");
		const received: string[] = [];
		const cancel = await state.summary.subscribe((value) => {
			received.push(value);
		});
		await vi.waitFor(() => expect(received).toEqual(["idle"]));
		await state.label.set("second");
		await state.count.set(3);
		await vi.waitFor(() => expect(received).toEqual(["idle", "second x3"]));
		cancel();
	});
});
