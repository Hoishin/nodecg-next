import { defineState } from "@nodecg/core";
import type { Result } from "neverthrow";
import { expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import { GetStateError, loadState } from "./load-state";

test("runs in a real browser", () => {
	expect(typeof window).toBe("object");
	expect(typeof document).toBe("object");
});

test("getValue fetches and returns the response body", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify(42), { status: 200 }),
	);

	const stateDefinition = defineState({ count: { schema: z.number() } });

	const state = loadState(stateDefinition);

	expectTypeOf(state).toEqualTypeOf<{
		count: {
			getValue: () => Promise<Result<number, GetStateError>>;
			update: (fn: (value: number) => number | Promise<number>) => Promise<Result<void, string>>;
		};
	}>();

	const value = await state.count.getValue();

	expect(value.isOk() && value.value).toBe(42);
	expect(globalThis.fetch).toHaveBeenCalledWith("/api/namespaces/root/state/count");
});

test("update reads the current value, applies the fn, and PUTs the result", async () => {
	let stored = 10;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		if (init?.method === "PUT") {
			stored = JSON.parse(init.body as string);
			return new Response(null, { status: 204 });
		}
		return new Response(JSON.stringify(stored), { status: 200 });
	});

	const stateDefinition = defineState({ count: { schema: z.number() } });
	const state = loadState(stateDefinition);

	await state.count.update((value) => value + 5);

	expect(stored).toBe(15);
});
