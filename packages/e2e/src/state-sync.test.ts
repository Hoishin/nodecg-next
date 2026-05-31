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

	test("subscribe receives published updates over the websocket", async () => {
		const state = await loadState({ manifest: fixtureManifest });
		const received: number[] = [];
		const cancel = state.count.subscribe((value) => {
			received.push(value);
		});
		// TODO: move .set() out of waitFor once subscribe is async
		await vi.waitFor(async () => {
			await state.count.set(7);
			expect(received).toContain(7);
		});
		cancel();
	});
});
