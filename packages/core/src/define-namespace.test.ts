import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import type { JsonValue } from "type-fest";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
	defineNamespace,
	extendNamespace,
	StateDecodeError,
	StateEncodeError,
} from "./define-namespace.ts";

describe("defineNamespace", () => {
	describe("runtime", () => {
		test(
			"state fields encode/decode round-trip",
			testEffect(
				Effect.gen(function* () {
					const manifest = defineNamespace("match", {
						state: {
							score: {
								schema: Schema.Struct({
									left: Schema.Number,
									right: Schema.Number,
								}),
							},
						},
					});

					const encoded = yield* manifest.state.score.encode({
						left: 1,
						right: 2,
					});
					expect(encoded).toEqual({ left: 1, right: 2 });

					const decoded = yield* manifest.state.score.decode({
						left: 3,
						right: 4,
					});
					expect(decoded).toEqual({ left: 3, right: 4 });
				}),
			),
		);

		test("empty groups are present as empty objects", () => {
			const manifest = defineNamespace("match", {
				state: { count: { schema: Schema.Number } },
			});

			expect(manifest.computed).toEqual({});
			expect(manifest.topic).toEqual({});
		});

		test("decode surfaces StateDecodeError on bad wire input", () => {
			const manifest = defineNamespace("match", {
				state: { count: { schema: Schema.Number } },
			});

			const error = Effect.runSync(
				Effect.flip(manifest.state.count.decode("nope")),
			);
			expect(error).toBeInstanceOf(StateDecodeError);
		});

		test("declaring a reserved role throws", () => {
			expect(() =>
				defineNamespace("match", {
					roles: { public: { permission: ["state-read"] } },
					state: { count: { schema: Schema.Number } },
				}),
			).toThrow(/reserved/);
		});
	});

	describe("permission resolution", () => {
		const manifest = defineNamespace("match", {
			roles: {
				judge: { permission: ["state-read", "state-write", "computed-read"] },
				monitor: { permission: ["computed-read"] },
				viewer: { permission: ["state-read", "computed-read"] },
			},
			state: {
				score: {
					schema: Schema.Number,
					permission: {
						read: { deny: ["viewer"] },
						write: { allow: ["judge"] },
					},
				},
				label: { schema: Schema.String },
				banner: {
					schema: Schema.String,
					permission: {
						read: { allow: ["client"] },
						write: { allow: ["server"] },
					},
				},
			},
			computed: {
				winning: { schema: Schema.NullOr(Schema.Literal("l", "r")) },
			},
		});

		test("no rule → inherits the role-level base", () => {
			expect(manifest.state.label.permission.read).toEqual(["judge", "viewer"]);
			expect(manifest.state.label.permission.write).toEqual(["judge"]);
		});

		test("deny subtracts from the base", () => {
			expect(manifest.state.score.permission.read).toEqual(["judge"]);
		});

		test("allow overrides the base", () => {
			expect(manifest.state.score.permission.write).toEqual(["judge"]);
		});

		test("client expands to all named roles + public", () => {
			expect(manifest.state.banner.permission.read).toEqual([
				"judge",
				"monitor",
				"public",
				"viewer",
			]);
		});

		test("server-owned write", () => {
			expect(manifest.state.banner.permission.write).toEqual(["server"]);
		});

		test("computed resolves its read base", () => {
			expect(manifest.computed.winning.permission.read).toEqual([
				"judge",
				"monitor",
				"viewer",
			]);
		});

		test("role-level deny vetoes a field allow", () => {
			const vetoed = defineNamespace("match", {
				roles: {
					judge: { permission: ["state-write"] },
					intern: { permission: ["state-read"], deny: ["state-write"] },
				},
				state: {
					score: {
						schema: Schema.Number,
						permission: { write: { allow: ["judge", "intern"] } },
					},
				},
			});

			expect(vetoed.state.score.permission.write).toEqual(["judge"]);
		});

		test("role-level deny does not touch a sibling capability", () => {
			const vetoed = defineNamespace("match", {
				roles: {
					intern: { permission: ["state-read"], deny: ["state-write"] },
				},
				state: { note: { schema: Schema.String } },
			});

			expect(vetoed.state.note.permission.read).toEqual(["intern"]);
			expect(vetoed.state.note.permission.write).toEqual([]);
		});
	});

	describe("types", () => {
		test("decoded type flows into the field codec per group", () => {
			const manifest = defineNamespace("match", {
				state: { label: { schema: Schema.NonEmptyTrimmedString } },
				computed: {
					winning: { schema: Schema.NullOr(Schema.Literal("left", "right")) },
				},
				topic: { start: { schema: Schema.Boolean } },
			});

			expectTypeOf(manifest.state.label.encode)
				.parameter(0)
				.toEqualTypeOf<string>();
			expectTypeOf(manifest.computed.winning.decode).returns.toEqualTypeOf<
				Effect.Effect<"left" | "right" | null, StateDecodeError>
			>();
			expectTypeOf(manifest.topic.start.encode)
				.parameter(0)
				.toEqualTypeOf<boolean>();
		});

		test("codec signatures and namespace type", () => {
			const manifest = defineNamespace("match", {
				state: { count: { schema: Schema.Number } },
			});

			expectTypeOf(manifest.namespace).toEqualTypeOf<string>();
			expectTypeOf(manifest.state.count.encode).returns.toEqualTypeOf<
				Effect.Effect<JsonValue, StateEncodeError>
			>();
			expectTypeOf(manifest.state.count.decode)
				.parameter(0)
				.toEqualTypeOf<JsonValue>();
		});

		describe("rejects schemas whose Encoded is not JsonValue-compatible", () => {
			test("DateFromSelf (Encoded = Date)", () => {
				defineNamespace("match", {
					// @ts-expect-error Schema.DateFromSelf has Encoded=Date, not JsonValue
					state: { when: { schema: Schema.DateFromSelf } },
				});
			});

			test("BigIntFromSelf (Encoded = bigint)", () => {
				defineNamespace("match", {
					// @ts-expect-error BigIntFromSelf Encoded is bigint, not JsonValue
					state: { count: { schema: Schema.BigIntFromSelf } },
				});
			});
		});
	});
});

describe("extendNamespace", () => {
	const base = defineNamespace("match", {
		roles: {
			judge: { permission: ["state-read", "state-write", "computed-read"] },
			viewer: { permission: ["state-read", "computed-read"] },
		},
		state: {
			score: { schema: Schema.Number },
			secret: {
				schema: Schema.String,
				permission: { read: { allow: ["judge"] } },
			},
		},
		computed: { total: { schema: Schema.Number } },
	});

	describe("runtime", () => {
		test("overrides an existing field's permission without a schema", () => {
			const extended = extendNamespace(base, {
				state: { score: { permission: { read: { deny: ["viewer"] } } } },
			});

			expect(extended.state.score.permission.read).toEqual(["judge"]);
			expect(extended.state.score.permission.write).toEqual(["judge"]);
		});

		test(
			"adds a new field with a schema, keeping existing fields",
			testEffect(
				Effect.gen(function* () {
					const extended = extendNamespace(base, {
						state: {
							pinned: {
								schema: Schema.String,
								permission: { write: { allow: ["judge"] } },
							},
						},
					});

					expect(yield* extended.state.pinned.encode("hi")).toBe("hi");
					expect(extended.state.pinned.permission.write).toEqual(["judge"]);
					expect(extended.state.score.permission.read).toEqual([
						"judge",
						"viewer",
					]);
				}),
			),
		);

		test("role-level deny retroactively vetoes existing fields, even allow-pinned", () => {
			const extended = extendNamespace(base, {
				roles: { judge: { permission: [], deny: ["state-write"] } },
			});

			expect(extended.state.score.permission.write).toEqual([]);
			expect(extended.state.secret.permission.write).toEqual([]);
		});

		test("role-level grant retroactively adds to existing lists, including pinned", () => {
			const extended = extendNamespace(base, {
				roles: { auditor: { permission: ["state-read"] } },
			});

			expect(extended.state.score.permission.read).toEqual([
				"auditor",
				"judge",
				"viewer",
			]);
			expect(extended.state.secret.permission.read).toEqual([
				"auditor",
				"judge",
			]);
		});

		test("callback form receives the resolved precedent", () => {
			const extended = extendNamespace(base, (precedent) => ({
				state: {
					mirror: {
						schema: Schema.Number,
						permission: {
							read: { allow: precedent.state.score.permission.read },
						},
					},
				},
			}));

			expect(extended.state.mirror.permission.read).toEqual([
				"judge",
				"viewer",
			]);
		});

		test(
			"adds fields across computed and topic groups",
			testEffect(
				Effect.gen(function* () {
					const extended = extendNamespace(base, {
						computed: { ratio: { schema: Schema.Number } },
						topic: { ping: { schema: Schema.String } },
					});

					expect(yield* extended.computed.ratio.encode(0.5)).toBe(0.5);
					expect(yield* extended.topic.ping.encode("x")).toBe("x");
					expect(extended.computed.ratio.permission.read).toEqual([
						"judge",
						"viewer",
					]);
					expect(extended.topic.ping.permission.subscribe).toEqual([]);
				}),
			),
		);

		test("declaring a reserved role throws", () => {
			expect(() =>
				extendNamespace(base, {
					roles: { public: { permission: ["state-read"] } },
				}),
			).toThrow(/reserved/);
		});
	});

	describe("types", () => {
		test("merges added field types into the manifest", () => {
			const extended = extendNamespace(base, {
				state: { pinned: { schema: Schema.NonEmptyTrimmedString } },
				computed: { ratio: { schema: Schema.Number } },
			});

			expectTypeOf(extended.state.score.encode)
				.parameter(0)
				.toEqualTypeOf<number>();
			expectTypeOf(extended.state.pinned.encode)
				.parameter(0)
				.toEqualTypeOf<string>();
			expectTypeOf(extended.computed.ratio.encode)
				.parameter(0)
				.toEqualTypeOf<number>();
		});
	});
});
