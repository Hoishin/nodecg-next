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
			"replicant fields encode/decode round-trip",
			testEffect(
				Effect.gen(function* () {
					const manifest = defineNamespace("match", {
						replicant: {
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

					const encoded = yield* manifest.replicant.score.encode({
						left: 1,
						right: 2,
					});
					expect(encoded).toEqual({ left: 1, right: 2 });

					const decoded = yield* manifest.replicant.score.decode({
						left: 3,
						right: 4,
					});
					expect(decoded).toEqual({ left: 3, right: 4 });
				}),
			),
		);

		test("decode surfaces FieldDecodeError on bad wire input", () => {
			const manifest = defineNamespace("match", {
				replicant: { count: { schema: Schema.Number } },
			});

			const error = Effect.runSync(
				Effect.flip(manifest.replicant.count.decode("nope")),
			);
			expect(error).toBeInstanceOf(FieldDecodeError);
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
				judge: {
					permission: ["replicant-read", "replicant-write", "computed-read"],
				},
				monitor: { permission: ["computed-read"] },
				viewer: { permission: ["replicant-read", "computed-read"] },
			},
			replicant: {
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
			expect(manifest.replicant.label.permission.read).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
			);
			expect(manifest.replicant.label.permission.write).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("deny subtracts from the base", () => {
			expect(manifest.replicant.score.permission.read).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("allow overrides the base, keeping the privileged principals", () => {
			expect(manifest.replicant.score.permission.write).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("client expands to all named roles", () => {
			expect(manifest.replicant.banner.permission.read).toEqual(
				new Set(["judge", "monitor", "viewer", "admin", "server"]),
			);
		});

		test("server-owned write", () => {
			expect(manifest.replicant.banner.permission.write).toEqual(
				new Set(["server", "admin"]),
			);
		});

		test("computed resolves its read base", () => {
			expect(manifest.computed.winning.permission.read).toEqual(
				new Set(["judge", "monitor", "viewer", "admin", "server"]),
			);
		});
	});

	describe("principals as capability bases", () => {
		test("everyone opens every field of the capability", () => {
			const manifest = defineNamespace("match", {
				principals: { everyone: { permission: ["computed-read"] } },
				roles: { judge: { permission: ["replicant-read"] } },
				replicant: { score: { schema: Schema.Number } },
				computed: { winning: { schema: Schema.Boolean } },
			});

			expect(manifest.computed.winning.permission.read).toEqual(
				new Set(["everyone", "admin", "server"]),
			);
			expect(manifest.replicant.score.permission.read).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("client never expands to a declared everyone", () => {
			const manifest = defineNamespace("match", {
				principals: { everyone: { permission: ["replicant-read"] } },
				roles: {
					judge: { permission: ["replicant-read"] },
					viewer: { permission: [] },
				},
				replicant: {
					internal: {
						schema: Schema.Number,
						permission: { read: { allow: ["client"] } },
					},
				},
			});

			expect(manifest.replicant.internal.permission.read).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
			);
		});

		test("client is a blanket base every named role holds", () => {
			const manifest = defineNamespace("match", {
				principals: { client: { permission: ["replicant-read"] } },
				roles: {
					judge: { permission: ["replicant-write"] },
					viewer: { permission: [] },
				},
				replicant: { score: { schema: Schema.Number } },
			});

			expect(manifest.replicant.score.permission.read).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
			);
			expect(manifest.replicant.score.permission.write).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("overriding the server principal narrows it to the declared capabilities", () => {
			const manifest = defineNamespace("match", {
				principals: { server: { permission: ["replicant-write"] } },
				roles: { viewer: { permission: ["replicant-read"] } },
				replicant: { score: { schema: Schema.Number } },
			});

			expect(manifest.replicant.score.permission.write).toEqual(
				new Set(["server", "admin"]),
			);
			expect(manifest.replicant.score.permission.read).toEqual(
				new Set(["viewer", "admin"]),
			);
		});

		test("overriding the admin principal overwrites its all-capabilities default", () => {
			const manifest = defineNamespace("match", {
				principals: { admin: { permission: ["replicant-read"] } },
				roles: { viewer: { permission: ["replicant-read"] } },
				replicant: { score: { schema: Schema.Number } },
			});

			expect(manifest.replicant.score.permission.read).toEqual(
				new Set(["admin", "viewer", "server"]),
			);
			expect(manifest.replicant.score.permission.write).toEqual(
				new Set(["server"]),
			);
		});

		test("a principal cannot be declared as a named role", () => {
			expect(() =>
				defineNamespace("match", {
					// @ts-expect-error a principal belongs under "principals"
					roles: { everyone: { permission: ["replicant-read"] } },
				}),
			).toThrow(/principal — declare it under "principals"/);
		});

		test("superadmin can be declared nowhere — it is granted, never declared", () => {
			expect(() =>
				defineNamespace("match", {
					// @ts-expect-error superadmin cannot be declared anywhere
					roles: { superadmin: { permission: ["replicant-read"] } },
				}),
			).toThrow(/granted to a user, never declared/);
		});

		test("a deny removes the admin from a field", () => {
			const manifest = defineNamespace("match", {
				roles: { judge: { permission: ["replicant-read"] } },
				replicant: {
					sealed: {
						schema: Schema.Number,
						permission: { read: { deny: ["admin"] } },
					},
				},
			});

			expect(manifest.replicant.sealed.permission.read).toEqual(
				new Set(["judge", "server"]),
			);
		});

		test("a deny removes the server from a field, allow-pinned or not", () => {
			const manifest = defineNamespace("match", {
				roles: { judge: { permission: ["replicant-read"] } },
				replicant: {
					sealed: {
						schema: Schema.Number,
						permission: { read: { deny: ["server"] } },
					},
					pinned: {
						schema: Schema.Number,
						permission: { read: { allow: ["judge"], deny: ["server"] } },
					},
				},
			});

			expect(manifest.replicant.sealed.permission.read).toEqual(
				new Set(["judge", "admin"]),
			);
			expect(manifest.replicant.pinned.permission.read).toEqual(
				new Set(["judge", "admin"]),
			);
		});
	});

	describe("rpc permission resolution", () => {
		test("rpc-call bakes into write, read stays empty", () => {
			const manifest = defineNamespace("match", {
				roles: {
					operator: { permission: ["rpc-call"] },
					viewer: { permission: ["replicant-read"] },
				},
				rpc: {
					restart: {
						schema: { request: Schema.Number, response: Schema.Number },
					},
				},
			});

			expect(manifest.rpc.restart.permission.write).toEqual(
				new Set(["operator", "admin", "server"]),
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
				new Set(["producer", "admin", "server"]),
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
				new Set(["server", "admin"]),
			);
			expect(manifest.topic.start.permission.read).toEqual(
				new Set(["viewer", "admin", "server"]),
			);
		});
	});

	describe("types", () => {
		test("options not specified are hidden", () => {
			const manifest = defineNamespace("match", {
				replicant: {
					count: { schema: Schema.Number },
				},
			});
			expectTypeOf(manifest.replicant).not.toBeNever();
			expectTypeOf(manifest.computed).toEqualTypeOf({});
			expectTypeOf(manifest.topic).toEqualTypeOf({});
			expectTypeOf(manifest.rpc).toEqualTypeOf({});

			const manifest2 = defineNamespace("match", {
				replicant: {
					count: { schema: Schema.Number },
				},
				computed: {
					double: { schema: Schema.Number },
				},
			});
			expectTypeOf(manifest2.replicant).not.toBeNever();
			expectTypeOf(manifest2.computed).not.toBeNever();
			expectTypeOf(manifest2.topic).toEqualTypeOf({});
			expectTypeOf(manifest2.rpc).toEqualTypeOf({});

			const manifest3 = defineNamespace("match", {
				topic: {
					count: { schema: Schema.Number },
				},
			});
			expectTypeOf(manifest3.replicant).toEqualTypeOf({});
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
			expectTypeOf(manifest4.replicant).toEqualTypeOf({});
			expectTypeOf(manifest4.computed).toEqualTypeOf({});
			expectTypeOf(manifest4.topic).toEqualTypeOf({});
			expectTypeOf(manifest4.rpc).not.toBeNever();
		});

		test("decoded type flows into the field codec per group", () => {
			const manifest = defineNamespace("match", {
				replicant: { label: { schema: Schema.NonEmptyTrimmedString } },
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

			expectTypeOf(manifest.replicant.label.encode)
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
				replicant: { count: { schema: Schema.Number } },
			});

			expectTypeOf(manifest.namespace).toEqualTypeOf<string>();
			expectTypeOf(manifest.replicant.count.encode).returns.toEqualTypeOf<
				Effect.Effect<JsonValue, FieldEncodeError>
			>();
			expectTypeOf(manifest.replicant.count.decode)
				.parameter(0)
				.toEqualTypeOf<JsonValue>();
		});

		describe("rejects schemas whose Encoded is not JsonValue-compatible", () => {
			test("DateFromSelf (Encoded = Date)", () => {
				defineNamespace("match", {
					// @ts-expect-error Schema.DateFromSelf has Encoded=Date, not JsonValue
					replicant: { when: { schema: Schema.DateFromSelf } },
				});
			});

			test("BigIntFromSelf (Encoded = bigint)", () => {
				defineNamespace("match", {
					// @ts-expect-error bigint is not assignable to JsonValue
					replicant: { count: { schema: Schema.BigIntFromSelf } },
				});
			});
		});

		describe("permission tokens restricted to declared + reserved roles", () => {
			test("accepts a declared role and any principal, declared or not", () => {
				const manifest = defineNamespace("match", {
					roles: { judge: { permission: ["replicant-read"] } },
					replicant: {
						score: {
							schema: Schema.Number,
							permission: {
								read: { allow: ["judge", "admin"] },
								write: { deny: ["everyone", "server"] },
							},
						},
					},
				});

				expect(manifest.replicant.score.permission.read).toEqual(
					new Set(["judge", "admin", "server"]),
				);
				expect(manifest.replicant.score.permission.write).toEqual(
					new Set(["admin"]),
				);
			});

			test("rejects an unknown token in allow or deny", () => {
				expect(() =>
					defineNamespace("match", {
						roles: { judge: { permission: ["replicant-read"] } },
						replicant: {
							score: {
								schema: Schema.Number,
								// @ts-expect-error "viewer" is neither a declared nor a reserved role
								permission: { read: { allow: ["viewer"] } },
							},
						},
					}),
				).toThrow(/Unknown role "viewer" in replicant "score" read\.allow/);

				expect(() =>
					defineNamespace("match", {
						roles: { judge: { permission: ["replicant-read"] } },
						replicant: {
							score: {
								schema: Schema.Number,
								// @ts-expect-error "vewer" is a typo, not a known role
								permission: { read: { deny: ["vewer"] } },
							},
						},
					}),
				).toThrow(/Unknown role "vewer" in replicant "score" read\.deny/);
			});
		});
	});
});

describe("extendNamespace", () => {
	const base = defineNamespace("match", {
		roles: {
			judge: {
				permission: ["replicant-read", "replicant-write", "computed-read"],
			},
			viewer: { permission: ["replicant-read", "computed-read"] },
		},
		replicant: {
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
				replicant: { score: { permission: { read: { deny: ["viewer"] } } } },
			});

			expect(extended.replicant.score.permission.read).toEqual(
				new Set(["judge", "admin", "server"]),
			);
			expect(extended.replicant.score.permission.write).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test(
			"adds a new field with a schema, keeping existing fields",
			testEffect(
				Effect.gen(function* () {
					const extended = extendNamespace(base, {
						replicant: {
							pinned: {
								schema: Schema.String,
								permission: { write: { allow: ["judge"] } },
							},
						},
					});

					expect(yield* extended.replicant.pinned.encode("hi")).toBe("hi");
					expect(extended.replicant.pinned.permission.write).toEqual(
						new Set(["judge", "admin", "server"]),
					);
					expect(extended.replicant.score.permission.read).toEqual(
						new Set(["judge", "viewer", "admin", "server"]),
					);
				}),
			),
		);

		test("role-level grant retroactively adds to existing lists, including pinned", () => {
			const extended = extendNamespace(base, {
				roles: { auditor: { permission: ["replicant-read"] } },
			});

			expect(extended.replicant.score.permission.read).toEqual(
				new Set(["auditor", "judge", "viewer", "admin", "server"]),
			);
			expect(extended.replicant.secret.permission.read).toEqual(
				new Set(["auditor", "judge", "admin", "server"]),
			);
		});

		test("re-listing a role's permissions overrides the previous set, vetoing dropped capabilities", () => {
			const extended = extendNamespace(base, {
				roles: { judge: { permission: ["replicant-read"] } },
			});

			expect(extended.replicant.score.permission.write).toEqual(
				new Set(["admin", "server"]),
			);
			expect(extended.computed.total.permission.read).toEqual(
				new Set(["viewer", "admin", "server"]),
			);
			expect(extended.replicant.secret.permission.read).toEqual(
				new Set(["judge", "admin", "server"]),
			);
			expect(extended.replicant.score.permission.read).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
			);
		});

		test("callback form receives the resolved precedent", () => {
			const extended = extendNamespace(base, (precedent) => ({
				replicant: {
					mirror: {
						schema: Schema.Number,
						permission: {
							read: { allow: [...precedent.replicant.score.permission.read] },
						},
					},
				},
			}));

			expect(extended.replicant.mirror.permission.read).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
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
						new Set(["judge", "viewer", "admin", "server"]),
					);
					expect(extended.topic.ping.permission.read).toEqual(
						new Set(["admin", "server"]),
					);
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
						new Set(["operator", "admin", "server"]),
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
			expect(vetoed.rpc.restart.permission.write).toEqual(
				new Set(["admin", "server"]),
			);

			const granted = extendNamespace(rpcBase, {
				roles: { producer: { permission: ["rpc-call"] } },
			});
			expect(granted.rpc.restart.permission.write).toEqual(
				new Set(["operator", "producer", "admin", "server"]),
			);
		});

		test("declaring everyone opens the precedent's fields, and re-listing it locks them back down", () => {
			const opened = extendNamespace(base, {
				principals: { everyone: { permission: ["replicant-read"] } },
			});
			expect(opened.replicant.score.permission.read).toEqual(
				new Set(["everyone", "judge", "viewer", "admin", "server"]),
			);
			expect(opened.replicant.secret.permission.read).toEqual(
				new Set(["everyone", "judge", "admin", "server"]),
			);

			const closed = extendNamespace(opened, {
				principals: { everyone: { permission: [] } },
			});
			expect(closed.replicant.score.permission.read).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
			);
			expect(closed.replicant.secret.permission.read).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("re-listing the server principal locks the precedent's fields against it", () => {
			const locked = extendNamespace(base, {
				principals: { server: { permission: [] } },
			});

			expect(locked.replicant.score.permission.write).toEqual(
				new Set(["judge", "admin"]),
			);
			expect(locked.replicant.secret.permission.read).toEqual(
				new Set(["judge", "admin"]),
			);
		});

		test("a client blanket reaches roles added in a later extend", () => {
			const blanketed = extendNamespace(base, {
				principals: { client: { permission: ["replicant-read"] } },
			});
			const withAuditor = extendNamespace(blanketed, {
				roles: { auditor: { permission: [] } },
			});

			expect(withAuditor.replicant.score.permission.read).toEqual(
				new Set(["auditor", "judge", "viewer", "admin", "server"]),
			);
		});

		test("re-listing client drops the blanket but keeps roles holding the capability outright", () => {
			const blanketed = extendNamespace(base, {
				principals: { client: { permission: ["replicant-write"] } },
				roles: { viewer: { permission: ["replicant-read"] } },
			});
			expect(blanketed.replicant.score.permission.write).toEqual(
				new Set(["judge", "viewer", "admin", "server"]),
			);

			const revoked = extendNamespace(blanketed, {
				principals: { client: { permission: [] } },
			});
			expect(revoked.replicant.score.permission.write).toEqual(
				new Set(["judge", "admin", "server"]),
			);
		});

		test("throws on an unknown token in an added field", () => {
			expect(() =>
				extendNamespace(base, {
					replicant: {
						pinned: {
							schema: Schema.String,
							permission: { write: { allow: ["jdge"] } },
						},
					},
				}),
			).toThrow(/Unknown role "jdge" in replicant "pinned" write\.allow/);
		});

		test("accepts a role added in the same extend as a field token", () => {
			const extended = extendNamespace(base, {
				roles: { auditor: { permission: ["replicant-read"] } },
				replicant: {
					pinned: {
						schema: Schema.String,
						permission: { read: { allow: ["auditor"] } },
					},
				},
			});

			expect(extended.replicant.pinned.permission.read).toEqual(
				new Set(["auditor", "admin", "server"]),
			);
		});
	});

	describe("types", () => {
		test("merges added field types into the manifest", () => {
			const extended = extendNamespace(base, {
				replicant: { pinned: { schema: Schema.NonEmptyTrimmedString } },
				computed: { ratio: { schema: Schema.Number } },
			});

			expectTypeOf(extended.replicant.score.encode)
				.parameter(0)
				.toEqualTypeOf<number>();
			expectTypeOf(extended.replicant.pinned.encode)
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
