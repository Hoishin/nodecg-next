import { testEffect } from "@nodecg/internal/test-utils";
import { Effect, Schema } from "effect";
import type { JsonValue } from "type-fest";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
	defineNamespace,
	extendNamespace,
	FieldDecodeError,
	FieldEncodeError,
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
							count: {
								schema: Schema.BigInt,
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

		test("decode surfaces FieldDecodeError on bad wire input", () => {
			const manifest = defineNamespace("match", {
				state: { count: { schema: Schema.Number } },
			});

			const error = Effect.runSync(
				Effect.flip(manifest.state.count.decode("nope")),
			);
			expect(error).toBeInstanceOf(FieldDecodeError);
		});

		test("declaring a reserved role throws", () => {
			expect(() =>
				defineNamespace("match", {
					roles: { anonymous: { permission: ["state-read"] } },
					state: { count: { schema: Schema.Number } },
				}),
			).toThrow(/reserved/);
		});

		test(
			"rpc request and response encode/decode round-trip independently",
			testEffect(
				Effect.gen(function* () {
					const manifest = defineNamespace("match", {
						rpc: {
							setScore: {
								schema: {
									request: Schema.Struct({
										left: Schema.Number,
										right: Schema.Number,
									}),
									response: Schema.Boolean,
								},
							},
						},
					});

					expect(
						yield* manifest.rpc.setScore.request.encode({ left: 1, right: 2 }),
					).toEqual({ left: 1, right: 2 });
					expect(
						yield* manifest.rpc.setScore.request.decode({ left: 3, right: 4 }),
					).toEqual({ left: 3, right: 4 });
					expect(yield* manifest.rpc.setScore.response.encode(true)).toBe(true);
					expect(yield* manifest.rpc.setScore.response.decode(false)).toBe(
						false,
					);
				}),
			),
		);
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
			expect(manifest.state.label.permission.read).toEqual(
				new Set(["judge", "viewer"]),
			);
			expect(manifest.state.label.permission.write).toEqual(new Set(["judge"]));
		});

		test("deny subtracts from the base", () => {
			expect(manifest.state.score.permission.read).toEqual(new Set(["judge"]));
		});

		test("allow overrides the base", () => {
			expect(manifest.state.score.permission.write).toEqual(new Set(["judge"]));
		});

		test("client expands to all named roles", () => {
			expect(manifest.state.banner.permission.read).toEqual(
				new Set(["judge", "monitor", "viewer"]),
			);
		});

		test("server-owned write", () => {
			expect(manifest.state.banner.permission.write).toEqual(
				new Set(["server"]),
			);
		});

		test("computed resolves its read base", () => {
			expect(manifest.computed.winning.permission.read).toEqual(
				new Set(["judge", "monitor", "viewer"]),
			);
		});
	});

	describe("rpc permission resolution", () => {
		test("rpc-call bakes into write, read stays empty", () => {
			const manifest = defineNamespace("match", {
				roles: {
					operator: { permission: ["rpc-call"] },
					viewer: { permission: ["state-read"] },
				},
				rpc: {
					restart: {
						schema: { request: Schema.Number, response: Schema.Number },
					},
				},
			});

			expect(manifest.rpc.restart.permission.write).toEqual(
				new Set(["operator"]),
			);
			expect(manifest.rpc.restart.permission.read).toEqual(new Set());
		});

		test("field deny subtracts from the rpc-call base", () => {
			const manifest = defineNamespace("match", {
				roles: {
					operator: { permission: ["rpc-call"] },
					producer: { permission: ["rpc-call"] },
				},
				rpc: {
					restart: {
						schema: { request: Schema.Number, response: Schema.Number },
						permission: { write: { deny: ["operator"] } },
					},
				},
			});

			expect(manifest.rpc.restart.permission.write).toEqual(
				new Set(["producer"]),
			);
		});
	});

	describe("topic direction presets", () => {
		test("server-only publish grants write to server, subscribe to holders", () => {
			const manifest = defineNamespace("match", {
				roles: { viewer: { permission: ["topic-subscribe"] } },
				topic: {
					start: {
						schema: Schema.Boolean,
						permission: { write: { allow: ["server"] } },
					},
				},
			});

			expect(manifest.topic.start.permission.write).toEqual(
				new Set(["server"]),
			);
			expect(manifest.topic.start.permission.read).toEqual(new Set(["viewer"]));
		});
	});

	describe("types", () => {
		test("options not specified are hidden", () => {
			const manifest = defineNamespace("match", {
				state: {
					count: { schema: Schema.Number },
				},
			});
			expectTypeOf(manifest.state).not.toBeNever();
			expectTypeOf(manifest.computed).toEqualTypeOf({});
			expectTypeOf(manifest.topic).toEqualTypeOf({});
			expectTypeOf(manifest.rpc).toEqualTypeOf({});

			const manifest2 = defineNamespace("match", {
				state: {
					count: { schema: Schema.Number },
				},
				computed: {
					double: { schema: Schema.Number },
				},
			});
			expectTypeOf(manifest2.state).not.toBeNever();
			expectTypeOf(manifest2.computed).not.toBeNever();
			expectTypeOf(manifest2.topic).toEqualTypeOf({});
			expectTypeOf(manifest2.rpc).toEqualTypeOf({});

			const manifest3 = defineNamespace("match", {
				topic: {
					count: { schema: Schema.Number },
				},
			});
			expectTypeOf(manifest3.state).toEqualTypeOf({});
			expectTypeOf(manifest3.computed).toEqualTypeOf({});
			expectTypeOf(manifest3.topic).not.toBeNever();
			expectTypeOf(manifest3.rpc).toEqualTypeOf({});

			const manifest4 = defineNamespace("match", {
				rpc: {
					ping: {
						schema: { request: Schema.String, response: Schema.String },
					},
				},
			});
			expectTypeOf(manifest4.state).toEqualTypeOf({});
			expectTypeOf(manifest4.computed).toEqualTypeOf({});
			expectTypeOf(manifest4.topic).toEqualTypeOf({});
			expectTypeOf(manifest4.rpc).not.toBeNever();
		});

		test("decoded type flows into the field codec per group", () => {
			const manifest = defineNamespace("match", {
				state: { label: { schema: Schema.NonEmptyTrimmedString } },
				computed: {
					winning: { schema: Schema.NullOr(Schema.Literal("left", "right")) },
				},
				topic: { start: { schema: Schema.Boolean } },
				rpc: {
					setScore: {
						schema: {
							request: Schema.Struct({ home: Schema.Number }),
							response: Schema.Boolean,
						},
					},
				},
			});

			expectTypeOf(manifest.state.label.encode)
				.parameter(0)
				.toEqualTypeOf<string>();
			expectTypeOf(manifest.computed.winning.decode).returns.toEqualTypeOf<
				Effect.Effect<"left" | "right" | null, FieldDecodeError>
			>();
			expectTypeOf(manifest.topic.start.encode)
				.parameter(0)
				.toEqualTypeOf<boolean>();
			expectTypeOf(manifest.rpc.setScore.request.encode)
				.parameter(0)
				.toEqualTypeOf<{ readonly home: number }>();
			expectTypeOf(manifest.rpc.setScore.response.decode).returns.toEqualTypeOf<
				Effect.Effect<boolean, FieldDecodeError>
			>();
		});

		test("codec signatures and namespace type", () => {
			const manifest = defineNamespace("match", {
				state: { count: { schema: Schema.Number } },
			});

			expectTypeOf(manifest.namespace).toEqualTypeOf<string>();
			expectTypeOf(manifest.state.count.encode).returns.toEqualTypeOf<
				Effect.Effect<JsonValue, FieldEncodeError>
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
					// @ts-expect-error bigint is not assignable to JsonValue
					state: { count: { schema: Schema.BigIntFromSelf } },
				});
			});
		});

		describe("permission tokens restricted to declared + reserved roles", () => {
			test("accepts a declared role and a reserved role", () => {
				defineNamespace("match", {
					roles: { judge: { permission: ["state-read"] } },
					state: {
						score: {
							schema: Schema.Number,
							permission: {
								read: { allow: ["judge", "client"] },
								write: { deny: ["anonymous", "server"] },
							},
						},
					},
				});
			});

			test("rejects an unknown token in allow or deny", () => {
				expect(() =>
					defineNamespace("match", {
						roles: { judge: { permission: ["state-read"] } },
						state: {
							score: {
								schema: Schema.Number,
								// @ts-expect-error "viewer" is neither a declared nor a reserved role
								permission: { read: { allow: ["viewer"] } },
							},
						},
					}),
				).toThrow(/Unknown role "viewer" in state "score" read\.allow/);

				expect(() =>
					defineNamespace("match", {
						roles: { judge: { permission: ["state-read"] } },
						state: {
							score: {
								schema: Schema.Number,
								// @ts-expect-error "vewer" is a typo, not a known role
								permission: { read: { deny: ["vewer"] } },
							},
						},
					}),
				).toThrow(/Unknown role "vewer" in state "score" read\.deny/);
			});

			test("rejects a tier role (admin/superadmin) as a field token", () => {
				expect(() =>
					defineNamespace("match", {
						roles: { judge: { permission: ["state-read"] } },
						state: {
							score: {
								schema: Schema.Number,
								// @ts-expect-error admin is a tier role, not a usable field token
								permission: { read: { allow: ["admin"] } },
							},
						},
					}),
				).toThrow(/Unknown role "admin" in state "score" read\.allow/);
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

			expect(extended.state.score.permission.read).toEqual(new Set(["judge"]));
			expect(extended.state.score.permission.write).toEqual(new Set(["judge"]));
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
					expect(extended.state.pinned.permission.write).toEqual(
						new Set(["judge"]),
					);
					expect(extended.state.score.permission.read).toEqual(
						new Set(["judge", "viewer"]),
					);
				}),
			),
		);

		test("role-level grant retroactively adds to existing lists, including pinned", () => {
			const extended = extendNamespace(base, {
				roles: { auditor: { permission: ["state-read"] } },
			});

			expect(extended.state.score.permission.read).toEqual(
				new Set(["auditor", "judge", "viewer"]),
			);
			expect(extended.state.secret.permission.read).toEqual(
				new Set(["auditor", "judge"]),
			);
		});

		test("re-listing a role's permissions overrides the previous set, vetoing dropped capabilities", () => {
			const extended = extendNamespace(base, {
				roles: { judge: { permission: ["state-read"] } },
			});

			expect(extended.state.score.permission.write).toEqual(new Set());
			expect(extended.computed.total.permission.read).toEqual(
				new Set(["viewer"]),
			);
			expect(extended.state.secret.permission.read).toEqual(new Set(["judge"]));
			expect(extended.state.score.permission.read).toEqual(
				new Set(["judge", "viewer"]),
			);
		});

		test("callback form receives the resolved precedent", () => {
			const extended = extendNamespace(base, (precedent) => ({
				state: {
					mirror: {
						schema: Schema.Number,
						permission: {
							read: { allow: [...precedent.state.score.permission.read] },
						},
					},
				},
			}));

			expect(extended.state.mirror.permission.read).toEqual(
				new Set(["judge", "viewer"]),
			);
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
					expect(extended.computed.ratio.permission.read).toEqual(
						new Set(["judge", "viewer"]),
					);
					expect(extended.topic.ping.permission.read).toEqual(new Set());
				}),
			),
		);

		test(
			"adds an rpc field with request/response and permission",
			testEffect(
				Effect.gen(function* () {
					const extended = extendNamespace(base, {
						roles: { operator: { permission: ["rpc-call"] } },
						rpc: {
							restart: {
								schema: {
									request: Schema.String,
									response: Schema.Boolean,
								},
								permission: { write: { allow: ["operator"] } },
							},
						},
					});

					expect(yield* extended.rpc.restart.request.encode("go")).toBe("go");
					expect(yield* extended.rpc.restart.response.decode(true)).toBe(true);
					expect(extended.rpc.restart.permission.write).toEqual(
						new Set(["operator"]),
					);
					expect(extended.rpc.restart.permission.read).toEqual(new Set());
				}),
			),
		);

		test("re-lists a role to re-bake rpc write, and grants retroactively", () => {
			const rpcBase = defineNamespace("match", {
				roles: { operator: { permission: ["rpc-call"] } },
				rpc: {
					restart: {
						schema: { request: Schema.Number, response: Schema.Number },
					},
				},
			});

			const vetoed = extendNamespace(rpcBase, {
				roles: { operator: { permission: [] } },
			});
			expect(vetoed.rpc.restart.permission.write).toEqual(new Set());

			const granted = extendNamespace(rpcBase, {
				roles: { producer: { permission: ["rpc-call"] } },
			});
			expect(granted.rpc.restart.permission.write).toEqual(
				new Set(["operator", "producer"]),
			);
		});

		test("declaring a reserved role throws", () => {
			expect(() =>
				extendNamespace(base, {
					roles: { anonymous: { permission: ["state-read"] } },
				}),
			).toThrow(/reserved/);
		});

		test("throws on an unknown token in an added field", () => {
			expect(() =>
				extendNamespace(base, {
					state: {
						pinned: {
							schema: Schema.String,
							permission: { write: { allow: ["jdge"] } },
						},
					},
				}),
			).toThrow(/Unknown role "jdge" in state "pinned" write\.allow/);
		});

		test("accepts a role added in the same extend as a field token", () => {
			const extended = extendNamespace(base, {
				roles: { auditor: { permission: ["state-read"] } },
				state: {
					pinned: {
						schema: Schema.String,
						permission: { read: { allow: ["auditor"] } },
					},
				},
			});

			expect(extended.state.pinned.permission.read).toEqual(
				new Set(["auditor"]),
			);
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

		test("merges added rpc field types into the manifest", () => {
			const extended = extendNamespace(base, {
				rpc: {
					setScore: {
						schema: {
							request: Schema.Struct({ home: Schema.Number }),
							response: Schema.Boolean,
						},
					},
				},
			});

			expectTypeOf(extended.rpc.setScore.request.encode)
				.parameter(0)
				.toEqualTypeOf<{ readonly home: number }>();
			expectTypeOf(extended.rpc.setScore.response.decode).returns.toEqualTypeOf<
				Effect.Effect<boolean, FieldDecodeError>
			>();
		});
	});
});
