import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { z } from "zod";

import { makeCodec } from "./field-codec.ts";

describe("makeCodec", () => {
	describe("Effect schema", () => {
		it.effect("encodes and decodes with the schema", () =>
			Effect.gen(function* () {
				const codec = makeCodec("count", Schema.FiniteFromString);

				const wire = yield* codec.encode(1);
				expect(wire).toBe("1");

				const count = yield* codec.decode("2");
				expect(count).toBe(2);
			}),
		);

		it.effect("fails to decode a value the schema refuses", () =>
			Effect.gen(function* () {
				const codec = makeCodec("count", Schema.FiniteFromString);

				const error = yield* Effect.flip(codec.decode("nope"));

				expect(error.message).toMatchInlineSnapshot(
					`"Failed to decode replicant "count": Expected a finite number"`,
				);
			}),
		);

		it.effect("mutableDecode shares nothing with the input", () =>
			Effect.gen(function* () {
				const codec = makeCodec("score", Schema.Struct({ data: Schema.Json }));
				const input = { data: { tags: ["a"] } };

				const score = yield* codec.mutableDecode(input);

				expect(score).toStrictEqual(input);
				expect(score.data).not.toBe(input.data);
			}),
		);
	});

	describe("Standard Schema", () => {
		it.effect("encodes and decodes with the schema", () =>
			Effect.gen(function* () {
				const codec = makeCodec("title", z.string().trim());

				const wire = yield* codec.encode(" final ");
				expect(wire).toBe("final");

				const title = yield* codec.decode(" semi ");
				expect(title).toBe("semi");
			}),
		);

		it.effect("fails to encode a value the schema refuses", () =>
			Effect.gen(function* () {
				const codec = makeCodec("round", z.number().min(1));

				const error = yield* Effect.flip(codec.encode(0));

				expect(error.message).toBe(
					'Failed to encode replicant "round": Too small: expected number to be >=1',
				);
			}),
		);

		it.effect("encodes a JSON value with unknown schema", () =>
			Effect.gen(function* () {
				const codec = makeCodec("anything", z.unknown());

				const wire = yield* codec.encode({ left: 1, tags: ["a"] });

				expect(wire).toEqual({ left: 1, tags: ["a"] });
			}),
		);

		it.effect("fails to encode non-JSON values with unknown schema", () =>
			Effect.gen(function* () {
				const codec = makeCodec("anything", z.unknown());

				const error = yield* Effect.flip(codec.encode({ left: 1n }));

				expect(error.message).toBe(
					'Failed to encode replicant "anything": Expected JSON value',
				);
			}),
		);

		it.effect("fails to decode a value the schema refuses", () =>
			Effect.gen(function* () {
				const codec = makeCodec("score", z.object({ left: z.number() }));

				const error = yield* Effect.flip(codec.decode({ left: "x" }));

				expect(error.message).toBe(
					'Failed to decode replicant "score": left: Invalid input: expected number, received string',
				);
			}),
		);

		it.effect("fails to decode with an asynchronous schema", () =>
			Effect.gen(function* () {
				const schema = z.string().refine(async (text) => text.length > 0);
				const codec = makeCodec("label", schema);

				const error = yield* Effect.flip(codec.decode("a"));

				expect(error.message).toBe(
					'Failed to decode replicant "label": The schema validated asynchronously',
				);
			}),
		);

		it.effect("fails to encode with an asynchronous schema", () =>
			Effect.gen(function* () {
				const schema = z.string().refine(async (text) => text.length > 0);
				const codec = makeCodec("label", schema);

				const error = yield* Effect.flip(codec.encode("a"));

				expect(error.message).toBe(
					'Failed to encode replicant "label": The schema validated asynchronously',
				);
			}),
		);

		it.effect("mutableDecode shares nothing with the input", () =>
			Effect.gen(function* () {
				const codec = makeCodec("score", z.object({ data: z.unknown() }));
				const input = { data: { tags: ["a"] } };

				const score = yield* codec.mutableDecode(input);

				expect(score).toStrictEqual(input);
				expect(score.data).not.toBe(input.data);
			}),
		);
	});
});
