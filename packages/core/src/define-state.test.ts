import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import type { JsonValue } from "type-fest";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
	defineState,
	StateValidationError,
	type StateDefinition,
} from "./define-state";

test(
	"base — Schema.Number encode/decode round-trip",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test", {
				count: { schema: Schema.Number },
			});

			expectTypeOf(manifest.definitions.count).toEqualTypeOf<
				StateDefinition<number>
			>();

			const encoded = yield* manifest.definitions.count.encode(123);
			expect(encoded).toBe(123);

			const decoded = yield* manifest.definitions.count.decode(456);
			expect(decoded).toBe(456);
		}),
	),
);

test("allows JsonValue-compatible schemas", () => {
	const manifest = defineState("test", {
		player: { schema: Schema.String },
		score: { schema: Schema.Number },
		active: { schema: Schema.Boolean },
		config: {
			schema: Schema.Struct({ name: Schema.String, score: Schema.Number }),
		},
		tags: { schema: Schema.Array(Schema.String) },
	});

	expectTypeOf(manifest.definitions.player).toEqualTypeOf<
		StateDefinition<string>
	>();
	expectTypeOf(manifest.definitions.config).toEqualTypeOf<
		StateDefinition<{ readonly name: string; readonly score: number }>
	>();
});

test(
	"bidirectional codec — DateFromString round-trip",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test", {
				when: { schema: Schema.DateFromString },
			});

			expectTypeOf(manifest.definitions.when).toEqualTypeOf<
				StateDefinition<Date>
			>();

			const encoded = yield* manifest.definitions.when.encode(new Date(0));
			expect(encoded).toBe("1970-01-01T00:00:00.000Z");

			const decoded = yield* manifest.definitions.when.decode(
				"1970-01-01T00:00:00.000Z",
			);
			expect(decoded).toEqual(new Date(0));
		}),
	),
);

test("nested struct with array of structs", () => {
	const manifest = defineState("test", {
		game: {
			schema: Schema.Struct({
				id: Schema.String,
				players: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						stats: Schema.Struct({
							wins: Schema.Number,
							losses: Schema.Number,
						}),
					}),
				),
			}),
		},
	});

	expectTypeOf(manifest.definitions.game.encode).parameter(0).toEqualTypeOf<{
		readonly id: string;
		readonly players: readonly {
			readonly name: string;
			readonly stats: {
				readonly wins: number;
				readonly losses: number;
			};
		}[];
	}>();
});

describe("does not allow schemas whose Encoded is not JsonValue-compatible", () => {
	test("DateFromSelf (Encoded = Date)", () => {
		defineState("test", {
			// @ts-expect-error Schema.DateFromSelf has Encoded=Date, not JsonValue
			when: { schema: Schema.DateFromSelf },
		});
	});

	test("Struct with bigint field (Encoded contains bigint)", () => {
		defineState("test", {
			nested: {
				// @ts-expect-error BigIntFromSelf Encoded is bigint, not JsonValue
				schema: Schema.Struct({ count: Schema.BigIntFromSelf }),
			},
		});
	});
});

test("encode returns StateValidationError on bad input", () => {
	const manifest = defineState("test", {
		count: { schema: Schema.Number },
	});

	const result = Effect.runSync(
		Effect.either(
			manifest.definitions.count.encode("not a number" as unknown as number),
		),
	);
	expect(result._tag).toBe("Left");
	if (result._tag === "Left") {
		expect(result.left).toBeInstanceOf(StateValidationError);
	}
});

test("decode returns StateValidationError on bad input", () => {
	const manifest = defineState("test", {
		count: { schema: Schema.Number },
	});

	const result = Effect.runSync(
		Effect.either(manifest.definitions.count.decode("not a number")),
	);
	expect(result._tag).toBe("Left");
	if (result._tag === "Left") {
		expect(result.left).toBeInstanceOf(StateValidationError);
	}
});

test("Encoded type flows through StateDefinition.encode return", () => {
	const manifest = defineState("test", {
		count: { schema: Schema.Number },
	});

	expectTypeOf(manifest.definitions.count.encode).toEqualTypeOf<
		(value: number) => Effect.Effect<JsonValue, StateValidationError>
	>();
});
