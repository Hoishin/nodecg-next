import { testEffect } from "@nodecg/private";
import { Context, Data, Effect, type HKT } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
	mapEffectValues,
	mapOptionalSchemaValues,
	mapValues,
} from "./map-values.ts";

interface IdentityLambda extends HKT.TypeLambda {
	readonly type: this["Target"];
}

interface ArrayLambda extends HKT.TypeLambda {
	readonly type: ReadonlyArray<this["Target"]>;
}

type Box<T> = { readonly value: T };
type Thunk<T> = () => T;
type HeadTail<T> = { readonly [P in "head" | "tail"]: T };
type PrefixedBox<T> = {
	readonly [K in keyof Box<T> as `box_${K & string}`]: Box<T>[K];
};
type WithId = { readonly id: number };

interface BoxLambda extends HKT.TypeLambda {
	readonly type: Box<this["Target"]>;
}

type SchemaBox<T> = { readonly schema: T };
interface SchemaBoxLambda extends HKT.TypeLambda {
	readonly type: SchemaBox<this["Target"]>;
}

interface ThunkLambda extends HKT.TypeLambda {
	readonly type: Thunk<this["Target"]>;
}

interface HeadTailLambda extends HKT.TypeLambda {
	readonly type: HeadTail<this["Target"]>;
}

interface PrefixedBoxLambda extends HKT.TypeLambda {
	readonly type: PrefixedBox<this["Target"]>;
}

interface WithIdLambda extends HKT.TypeLambda {
	readonly Target: WithId;
	readonly type: this["Target"];
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
			readonly a: ReadonlyArray<number>;
			readonly b: ReadonlyArray<string>;
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

	test("maps each value into a mapped-object shape, keeping value types distinct per key", () => {
		const result = mapValues<
			IdentityLambda,
			HeadTailLambda,
			{ a: number; b: string }
		>({ a: 1, b: "two" }, (value) => ({ head: value, tail: value }));
		expectTypeOf(result).toEqualTypeOf<{
			readonly a: { readonly head: number; readonly tail: number };
			readonly b: { readonly head: string; readonly tail: string };
		}>();
		expect(result).toEqual({
			a: { head: 1, tail: 1 },
			b: { head: "two", tail: "two" },
		});
	});

	test("preserves distinct per-key return types when the transform produces functions", () => {
		const result = mapValues<
			IdentityLambda,
			ThunkLambda,
			{ count: number; label: string }
		>({ count: 2, label: "x" }, (value) => () => value);
		expectTypeOf(result).toEqualTypeOf<{
			readonly count: () => number;
			readonly label: () => string;
		}>();
		expect(result.count()).toBe(2);
		expect(result.label()).toBe("x");
	});

	test("reduces a non-identity F lambda on the input side", () => {
		const result = mapValues<
			BoxLambda,
			IdentityLambda,
			{ a: number; b: string }
		>({ a: { value: 1 }, b: { value: "two" } }, (value) => value.value);
		expectTypeOf(result).toEqualTypeOf<{
			readonly a: number;
			readonly b: string;
		}>();
		expect(result).toEqual({ a: 1, b: "two" });
	});

	test("resolves a keyof-remapped, indexed mapped-object G lambda per key", () => {
		const result = mapValues<
			IdentityLambda,
			PrefixedBoxLambda,
			{ a: number; b: string }
		>({ a: 1, b: "two" }, (value) => ({ box_value: value }));
		expectTypeOf(result).toEqualTypeOf<{
			readonly a: { readonly box_value: number };
			readonly b: { readonly box_value: string };
		}>();
		expect(result).toEqual({ a: { box_value: 1 }, b: { box_value: "two" } });
	});

	test("respects a Lambda that specifies a constrained Target", () => {
		const result = mapValues<
			WithIdLambda,
			BoxLambda,
			{ a: { id: number; tag: string }; b: { id: number; tag: number } }
		>({ a: { id: 1, tag: "x" }, b: { id: 2, tag: 9 } }, (value) => ({ value }));
		expectTypeOf(result).toEqualTypeOf<{
			readonly a: { readonly value: { id: number; tag: string } };
			readonly b: { readonly value: { id: number; tag: number } };
		}>();
		expect(result).toEqual({
			a: { value: { id: 1, tag: "x" } },
			b: { value: { id: 2, tag: 9 } },
		});
		mapValues<WithIdLambda, BoxLambda, { a: string }>(
			// @ts-expect-error Target must satisfy { id: number }
			{ a: "no id" },
			(value) => ({ value }),
		);
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
						{
							readonly a: ReadonlyArray<number>;
							readonly b: ReadonlyArray<string>;
						},
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
						{
							readonly a: ReadonlyArray<number>;
							readonly b: ReadonlyArray<number>;
						},
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
						{
							readonly a: ReadonlyArray<number>;
							readonly b: ReadonlyArray<number>;
						},
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
		"maps into a mapped-object shape carrying both the error and context channels",
		testEffect(
			Effect.gen(function* () {
				const effect = mapEffectValues<
					IdentityLambda,
					HeadTailLambda,
					{ a: number; b: number }
				>()({ a: 1, b: 2 }, (value, key) =>
					key === "b"
						? Effect.fail(new TransformError({ key }))
						: Effect.gen(function* () {
								yield* BoxService;
								return { head: value, tail: value };
							}),
				);
				expectTypeOf(effect).toEqualTypeOf<
					Effect.Effect<
						{
							readonly a: { readonly head: number; readonly tail: number };
							readonly b: { readonly head: number; readonly tail: number };
						},
						TransformError,
						BoxService
					>
				>();
				const error = yield* effect.pipe(
					Effect.provideService(BoxService, {
						box: (value) => [value, value],
					}),
					Effect.flip,
				);
				expect(error._tag).toBe("TransformError");
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

describe("mapOptionalSchemaValues", () => {
	test("maps only the entries carrying a schema, keyed by T", () => {
		const entries: Record<
			string,
			{ readonly schema?: unknown; readonly permission?: ReadonlyArray<string> }
		> = {
			a: { schema: 1 },
			b: { schema: "two" },
			skip: { permission: ["someone"] },
		};
		const result = mapOptionalSchemaValues<
			SchemaBoxLambda,
			ArrayLambda,
			{ a: number; b: string }
		>(entries, (value) => [value.schema]);
		expectTypeOf(result).toEqualTypeOf<{
			readonly a: ReadonlyArray<number>;
			readonly b: ReadonlyArray<string>;
		}>();
		expect(result).toEqual({ a: [1], b: ["two"] });
	});

	test("passes the key to the transform, skipping schema-less entries", () => {
		const keys: string[] = [];
		mapOptionalSchemaValues<
			SchemaBoxLambda,
			ArrayLambda,
			{ a: number; b: number }
		>({ a: { schema: 1 }, b: { schema: 2 }, skip: {} }, (value, key) => {
			keys.push(key);
			return [value.schema];
		});
		expect(keys.sort()).toEqual(["a", "b"]);
	});

	test("returns an empty object for an undefined input", () => {
		const result = mapOptionalSchemaValues<
			SchemaBoxLambda,
			ArrayLambda,
			Record<string, number>
		>(undefined, (value) => [value.schema]);
		expect(result).toEqual({});
	});
});
