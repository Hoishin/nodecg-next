import { defineState } from "@nodecg/core";
import type { Result } from "neverthrow";
import { assert, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import { GetStateError, loadState, UpdateStateError } from "./load-state";

test("runs in a real browser", () => {
	expect(typeof window).toBe("object");
	expect(typeof document).toBe("object");
});

test("getValue fetches and returns the response body", async () => {
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(JSON.stringify(42), { status: 200 }));

	const manifest = defineState("root", {
		count: { schema: z.number().default(0) },
	});

	const state = loadState(manifest);

	expectTypeOf(state).toEqualTypeOf<{
		count: {
			getValue: () => Promise<number>;
			safeGetValue: () => Promise<Result<number, GetStateError>>;
			set: (value: number) => Promise<void>;
			safeSet: (value: number) => Promise<Result<void, UpdateStateError>>;
			update: (fn: (value: number) => number | Promise<number>) => Promise<void>;
			safeUpdate: (
				fn: (value: number) => number | Promise<number>,
			) => Promise<Result<void, UpdateStateError>>;
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
		count: { schema: z.number().default(0) },
	});
	const state = loadState(manifest);

	await state.count.update((value) => value + 5);

	expect(stored).toBe(15);
});
