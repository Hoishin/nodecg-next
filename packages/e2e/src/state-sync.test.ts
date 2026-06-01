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
});
