import { testEffect } from "@nodecg/private";
import { Context, Data, Effect, type HKT } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";

import { mapEffectValues, mapValues } from "./map-values";

interface IdentityLambda extends HKT.TypeLambda {
	readonly type: this["Target"];
}

interface ArrayLambda extends HKT.TypeLambda {
	readonly type: ReadonlyArray<this["Target"]>;
}

class TransformError extends Data.TaggedError("TransformError")<{
	key: string;
}> {}

class BoxService extends Context.Tag("BoxService")<
	BoxService,
	{ readonly box: <X>(value: X) => ReadonlyArray<X> }
>() {}

describe("mapValues", () => {
	test("applies the transform to every value, preserving keys and per-key value types", () => {
		const result = mapValues<
			IdentityLambda,
			ArrayLambda,
			{ a: number; b: string }
		>({ a: 1, b: "two" }, (value) => [value]);
		expectTypeOf(result).toEqualTypeOf<{
			a: ReadonlyArray<number>;
			b: ReadonlyArray<string>;
		}>();
		expect(result).toEqual({ a: [1], b: ["two"] });
	});

	test("passes the key to the transform", () => {
		const keys: string[] = [];
		mapValues<IdentityLambda, ArrayLambda, { a: number; b: number }>(
			{ a: 1, b: 2 },
			(value, key) => {
				keys.push(key);
				return [value];
			},
		);
		expect(keys.sort()).toEqual(["a", "b"]);
	});

	test("returns an empty object for an empty input", () => {
		const result = mapValues<
			IdentityLambda,
			ArrayLambda,
			Record<string, number>
		>({}, (value) => [value]);
		expect(result).toEqual({});
	});
});

describe("mapEffectValues", () => {
	test(
		"collects the resolved values into a record, with E and R never",
		testEffect(
			Effect.gen(function* () {
				const effect = mapEffectValues<
					IdentityLambda,
					ArrayLambda,
					{ a: number; b: string }
				>()({ a: 1, b: "two" }, (value) => Effect.succeed([value]));
				expectTypeOf(effect).toEqualTypeOf<
					Effect.Effect<
						{ a: ReadonlyArray<number>; b: ReadonlyArray<string> },
						never,
						never
					>
				>();
				expect(yield* effect).toEqual({ a: [1], b: ["two"] });
			}),
		),
	);

	test(
		"passes the key to the transform",
		testEffect(
			Effect.gen(function* () {
				const keys: string[] = [];
				yield* mapEffectValues<
					IdentityLambda,
					ArrayLambda,
					{ a: number; b: number }
				>()({ a: 1, b: 2 }, (value, key) => {
					keys.push(key);
					return Effect.succeed([value]);
				});
				expect(keys.sort()).toEqual(["a", "b"]);
			}),
		),
	);

	test(
		"propagates the transform's error channel",
		testEffect(
			Effect.gen(function* () {
				const effect = mapEffectValues<
					IdentityLambda,
					ArrayLambda,
					{ a: number; b: number }
				>()({ a: 1, b: 2 }, (value, key) =>
					key === "b"
						? Effect.fail(new TransformError({ key }))
						: Effect.succeed([value]),
				);
				expectTypeOf(effect).toEqualTypeOf<
					Effect.Effect<
						{ a: ReadonlyArray<number>; b: ReadonlyArray<number> },
						TransformError,
						never
					>
				>();
				const error = yield* effect.pipe(Effect.flip);
				expect(error._tag).toBe("TransformError");
			}),
		),
	);

	test(
		"propagates the transform's context channel",
		testEffect(
			Effect.gen(function* () {
				const effect = mapEffectValues<
					IdentityLambda,
					ArrayLambda,
					{ a: number; b: number }
				>()({ a: 1, b: 2 }, (value) =>
					Effect.gen(function* () {
						const service = yield* BoxService;
						return service.box(value);
					}),
				);
				expectTypeOf(effect).toEqualTypeOf<
					Effect.Effect<
						{ a: ReadonlyArray<number>; b: ReadonlyArray<number> },
						never,
						BoxService
					>
				>();
				const result = yield* effect.pipe(
					Effect.provideService(BoxService, {
						box: (value) => [value, value],
					}),
				);
				expect(result).toEqual({ a: [1, 1], b: [2, 2] });
			}),
		),
	);

	test(
		"returns an empty object for an empty input",
		testEffect(
			Effect.gen(function* () {
				const result = yield* mapEffectValues<
					IdentityLambda,
					ArrayLambda,
					Record<string, number>
				>()({}, (value) => Effect.succeed([value]));
				expect(result).toEqual({});
			}),
		),
	);
});
