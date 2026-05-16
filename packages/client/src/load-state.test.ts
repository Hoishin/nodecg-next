import { defineState } from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import { describe, expect, test, vi } from "vitest";

import { loadState, loadStateEffect } from "./load-state";
import {
	StateNotFound,
	type StateTransport,
	StateTransportService,
} from "./state-transport";

const createTransportStub = () =>
	({
		read: vi.fn<StateTransport["read"]>(),
		update: vi.fn<StateTransport["update"]>(() => Effect.void),
	}) satisfies StateTransport;

describe("getValue", () => {
	test(
		"decodes the value returned by the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(Effect.succeed(42));
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				expect(
					yield* state.count
						.getValue()
						.pipe(Effect.provideService(StateTransportService, transportStub)),
				).toBe(42);
			}),
		),
	);

	test(
		"fails when the stored value does not match the schema",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(Effect.succeed("not a number"));
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				const error = yield* state.count
					.getValue()
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("GetStateError");
			}),
		),
	);

	test(
		"propagates StateNotFound from the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(
					Effect.fail(new StateNotFound({ namespace: "root", name: "count" })),
				);
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				const error = yield* state.count
					.getValue()
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("GetStateError");
			}),
		),
	);

	test(
		"reads a stored string back into a Date",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(
					Effect.succeed("2030-01-01T00:00:00.000Z"),
				);
				const manifest = defineState("root", {
					when: { schema: Schema.DateFromString },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				expect(
					yield* state.when
						.getValue()
						.pipe(Effect.provideService(StateTransportService, transportStub)),
				).toEqual(new Date("2030-01-01T00:00:00.000Z"));
			}),
		),
	);
});

describe("set", () => {
	test(
		"encodes the value and writes it via the transport",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				yield* state.count
					.set(7)
					.pipe(Effect.provideService(StateTransportService, transportStub));
				expect(transportStub.update).toHaveBeenCalledWith("root", "count", 7);
			}),
		),
	);

	test(
		"fails when the value fails schema validation",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				const error = yield* state.count
					.set("not a number" as unknown as number)
					.pipe(
						Effect.provideService(StateTransportService, transportStub),
						Effect.flip,
					);
				expect(error._tag).toBe("UpdateStateError");
			}),
		),
	);

	test(
		"sends a Date to the transport as a string",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				const manifest = defineState("root", {
					when: { schema: Schema.DateFromString },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				yield* state.when
					.set(new Date("2030-01-01T00:00:00.000Z"))
					.pipe(Effect.provideService(StateTransportService, transportStub));
				expect(transportStub.update).toHaveBeenLastCalledWith(
					"root",
					"when",
					"2030-01-01T00:00:00.000Z",
				);
			}),
		),
	);
});

describe("update", () => {
	test(
		"reads the current value, applies the fn, and writes the result",
		testEffect(
			Effect.gen(function* () {
				const transportStub = createTransportStub();
				transportStub.read.mockReturnValue(Effect.succeed(10));
				const manifest = defineState("root", {
					count: { schema: Schema.Number },
				});

				const state = yield* loadStateEffect(manifest).pipe(
					Effect.provideService(StateTransportService, transportStub),
				);

				yield* state.count
					.update((v) => v + 5)
					.pipe(Effect.provideService(StateTransportService, transportStub));
				expect(transportStub.update).toHaveBeenLastCalledWith(
					"root",
					"count",
					15,
				);
			}),
		),
	);
});

describe("loadState (Promise wrapper)", () => {
	test("forwards to the injected transport", async () => {
		const transportStub = createTransportStub();
		transportStub.read.mockReturnValue(Effect.succeed(42));
		const manifest = defineState("root", { count: { schema: Schema.Number } });

		const state = await loadState({ manifest, stateTransport: transportStub });

		expect(await state.count.getValue()).toBe(42);
		await state.count.set(9);
		expect(transportStub.update).toHaveBeenCalledWith("root", "count", 9);
	});
});
