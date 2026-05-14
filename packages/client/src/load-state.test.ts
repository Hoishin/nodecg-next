import { defineState } from "@nodecg/core";
import { Schema } from "effect";
import { assert, expect, expectTypeOf, test, vi } from "vitest";

import { loadState } from "./load-state";

test("getValue fetches and returns the response body", async () => {
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(JSON.stringify(42), { status: 200 }));

	const manifest = defineState("root", {
		count: { schema: Schema.Number, initialValue: () => 0 },
	});

	const state = loadState(manifest);

	expectTypeOf(state).toExtend<{
		count: {
			getValue: () => Promise<number>;
			set: (value: number) => Promise<void>;
			update: (
				fn: (value: number) => number | Promise<number>,
			) => Promise<void>;
		};
	}>();

	const value = await state.count.getValue();

	expect(value).toBe(42);
	const [input] = fetchSpy.mock.calls[0] ?? [];
	assert(input != null);
	expect(new Request(input).url).toMatch("/api/namespaces/root/state/count");
});

test("update reads the current value, applies the fn, and PUTs the result", async () => {
	let stored = 10;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		if (init?.method === "PUT") {
			stored = JSON.parse(await new Response(init.body).text());
			return new Response(null, { status: 204 });
		}
		return new Response(JSON.stringify(stored), { status: 200 });
	});

	const manifest = defineState("root", {
		count: { schema: Schema.Number, initialValue: () => 0 },
	});
	const state = loadState(manifest);

	await state.count.update((value) => value + 5);

	expect(stored).toBe(15);
});

test("bidirectional codec round-trips through HTTP", async () => {
	let stored: string | null = null;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		if (init?.method === "PUT") {
			stored = JSON.parse(await new Response(init.body).text()) as string;
			return new Response(null, { status: 204 });
		}
		return new Response(JSON.stringify(stored ?? "2026-05-14T00:00:00.000Z"), {
			status: 200,
		});
	});

	const manifest = defineState("root", {
		when: {
			schema: Schema.DateFromString,
			initialValue: () => new Date(0),
		},
	});
	const state = loadState(manifest);

	const initial = await state.when.getValue();
	expect(initial).toEqual(new Date("2026-05-14T00:00:00.000Z"));

	const newDate = new Date("2030-01-01T00:00:00.000Z");
	await state.when.set(newDate);

	expect(stored).toBe("2030-01-01T00:00:00.000Z");
});
