import { defineNamespace } from "@nodecg/core";
import {
	ReplicantDeltaMessage,
	ReplicantSnapshotMessage,
	type ServerMessage,
	SubscribeRejectedMessage,
} from "@nodecg/internal";
import { computeFingerprint } from "@nodecg/internal/occ";
import { testEffect } from "@nodecg/internal/test-utils";
import { effect, type Signal } from "@preact/signals-core";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { describe, expect, onTestFinished, test, vi } from "vitest";

import { FieldCellsService } from "./field-cells.ts";
import { Loadable, Pending, ReadyLoadableValue } from "./loadable.ts";
import {
	FieldNotFound,
	FieldPermissionDenied,
	FieldUnavailable,
} from "./services/field-transport/field-transport.ts";
import {
	type MessageChannel,
	MessageChannelService,
} from "./services/message-channel/message-channel.ts";

const namespace = defineNamespace("match", {
	replicant: {
		scoreLeft: { schema: Schema.NumberFromString },
		scoreRight: { schema: Schema.NumberFromString },
	},
	computed: {
		total: { schema: Schema.NumberFromString },
	},
});

const makeFakeChannel = Effect.gen(function* () {
	const pubsub = yield* PubSub.unbounded<ServerMessage>();
	const sent: Parameters<MessageChannel["send"]>[0][] = [];
	const channel: MessageChannel = {
		send: (message) =>
			Effect.sync(() => {
				sent.push(message);
			}),
		receive: () => Stream.fromPubSub(pubsub, { scoped: true }),
	};
	return { channel, pubsub, sent };
});

const snapshot = (
	name: string,
	value: number | string,
	revision = 1,
): ServerMessage =>
	ReplicantSnapshotMessage.make({
		field: { type: "replicant", namespace: "match", name },
		value: String(value),
		revision,
	});

const delta = (
	name: string,
	value: string,
	baseRevision: number,
	revision: number,
	hash: number,
): ServerMessage =>
	ReplicantDeltaMessage.make({
		field: { type: "replicant", namespace: "match", name },
		ops: [{ op: "replace", path: "", value }],
		baseRevision,
		revision,
		hash,
	});

const resync = {
	_tag: "resync",
	field: { type: "replicant", namespace: "match", name: "scoreLeft" },
};

const waitFor = (assertion: () => void) =>
	Effect.promise(() => vi.waitFor(assertion));

const makeCells = Layer.build(FieldCellsService.Default).pipe(
	Effect.map((context) => Context.get(context, FieldCellsService)),
);

const observe = <V>(target: Signal<V>) => {
	const seen: V[] = [];
	const dispose = effect(() => {
		seen.push(target.value);
	});
	onTestFinished(() => dispose());
	return { seen, dispose };
};

const ready = (decoded: number, encoded: string, revision: number) =>
	Loadable.Ready({
		value: ReadyLoadableValue.Replicant({ decoded, encoded, revision }),
	});

describe("FieldCellsService", () => {
	test(
		"subscribes on the first watcher and goes Ready when a publish arrives",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(
						sent.some(
							(m) => m._tag === "subscribe" && m.field.name === "scoreLeft",
						),
					).toBe(true);
				});

				yield* pubsub.publish(snapshot("scoreLeft", 5));
				yield* waitFor(() => {
					expect(seen).toEqual([Pending, ready(5, "5", 1)]);
				});
			}),
		),
	);

	test(
		"unsubscribes when the last watcher goes away",
		testEffect(
			Effect.gen(function* () {
				const { channel, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const first = observe(cell.signal);
				const second = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.filter((m) => m._tag === "subscribe")).toHaveLength(1);
				});
				expect(first.seen).toEqual([Pending]);
				expect(second.seen).toEqual([Pending]);

				first.dispose();
				expect(sent.some((m) => m._tag === "unsubscribe")).toBe(false);
				second.dispose();
				yield* waitFor(() => {
					expect(
						sent.some(
							(m) => m._tag === "unsubscribe" && m.field.name === "scoreLeft",
						),
					).toBe(true);
				});
				expect(cell.peek()._tag).toBe("Cold");
			}),
		),
	);

	test(
		"does not collide fields whose space-joined key would match",
		testEffect(
			Effect.gen(function* () {
				const { channel } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				cells.replicant("a", "b c", namespace.replicant.scoreLeft);
				expect(() =>
					cells.replicant("a b", "c", namespace.replicant.scoreLeft),
				).not.toThrow();
			}),
		),
	);

	test(
		"fails the cell with FieldPermissionDenied when the subscribe is forbidden",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(
					SubscribeRejectedMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						reason: "forbidden",
					}),
				);

				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						Loadable.Failure({
							error: new FieldPermissionDenied({
								namespace: "match",
								name: "scoreLeft",
							}),
						}),
					]);
				});
			}),
		),
	);

	test(
		"fails the cell with FieldNotFound when the field does not exist",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(
					SubscribeRejectedMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						reason: "not-found",
					}),
				);

				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						Loadable.Failure({
							error: new FieldNotFound({
								namespace: "match",
								name: "scoreLeft",
							}),
						}),
					]);
				});
			}),
		),
	);

	test(
		"fails the cell with FieldUnavailable when a computed subscribe is unavailable",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = cells.computed("match", "total", namespace.computed.total);

				const { seen } = observe(cell.signal);

				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(
					SubscribeRejectedMessage.make({
						field: { type: "computed", namespace: "match", name: "total" },
						reason: "unavailable",
						message: "compute boom",
					}),
				);

				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						Loadable.Failure({
							error: new FieldUnavailable({
								namespace: "match",
								name: "total",
								detail: "compute boom",
							}),
						}),
					]);
				});
			}),
		),
	);

	test(
		"re-arms a rejected field to Pending on a fresh subscribe so a later publish heals it",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const first = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});
				yield* pubsub.publish(
					SubscribeRejectedMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						reason: "forbidden",
					}),
				);
				yield* waitFor(() => {
					expect(first.seen).toEqual([
						Pending,
						Loadable.Failure({
							error: new FieldPermissionDenied({
								namespace: "match",
								name: "scoreLeft",
							}),
						}),
					]);
				});
				first.dispose();
				expect(cell.peek()._tag).toBe("Cold");

				const second = observe(cell.signal);
				yield* pubsub.publish(snapshot("scoreLeft", 5));
				yield* waitFor(() => {
					expect(second.seen).toEqual([Pending, ready(5, "5", 1)]);
				});
			}),
		),
	);

	test(
		"fails the cell with FieldUnavailable when a publish does not decode, and goes Ready again on the next publish that does",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(snapshot("scoreLeft", 5));
				yield* pubsub.publish(snapshot("scoreLeft", "not a number", 2));
				yield* pubsub.publish(snapshot("scoreLeft", 7, 3));
				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						ready(5, "5", 1),
						Loadable.Failure({
							error: expect.objectContaining({
								_tag: "FieldUnavailable",
								namespace: "match",
								name: "scoreLeft",
								detail: expect.stringContaining(
									"published value did not decode",
								),
							}),
						}),
						ready(7, "7", 3),
					]);
				});
			}),
		),
	);

	test(
		"drops a publish that lands after the field went cold",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const left = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);
				const right = yield* cells.replicant(
					"match",
					"scoreRight",
					namespace.replicant.scoreRight,
				);

				const leftObserved = observe(left.signal);
				const rightObserved = observe(right.signal);
				yield* waitFor(() => {
					expect(sent.filter((m) => m._tag === "subscribe")).toHaveLength(2);
				});

				leftObserved.dispose();
				yield* pubsub.publish(snapshot("scoreLeft", 7));
				yield* pubsub.publish(snapshot("scoreRight", 9));
				yield* waitFor(() => {
					expect(rightObserved.seen).toEqual([Pending, ready(9, "9", 1)]);
				});
				expect(leftObserved.seen).toEqual([Pending]);
				expect(left.peek()._tag).toBe("Cold");
			}),
		),
	);

	test(
		"applies an op-delta on the held revision, and resyncs on a revision gap",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(snapshot("scoreLeft", 0, 0));
				yield* pubsub.publish(
					delta("scoreLeft", "5", 0, 1, computeFingerprint("5")),
				);
				yield* waitFor(() => {
					expect(seen).toEqual([Pending, ready(0, "0", 0), ready(5, "5", 1)]);
				});

				yield* pubsub.publish(
					delta("scoreLeft", "9", 99, 100, computeFingerprint("9")),
				);
				yield* waitFor(() => {
					expect(sent).toContainEqual(resync);
				});
				expect(seen).toEqual([Pending, ready(0, "0", 0), ready(5, "5", 1)]);
			}),
		),
	);

	test(
		"a delta arriving before the seed is dropped, not resynced",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(
					delta("scoreLeft", "5", 0, 1, computeFingerprint("5")),
				);
				yield* pubsub.publish(snapshot("scoreLeft", 7, 7));
				yield* waitFor(() => {
					expect(seen).toEqual([Pending, ready(7, "7", 7)]);
				});
				expect(sent).not.toContainEqual(resync);
			}),
		),
	);

	test(
		"resyncs on a delta at or below the held revision, and the answering snapshot replaces the held value",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(snapshot("scoreLeft", 1000, 1000));
				yield* pubsub.publish(
					delta("scoreLeft", "4", 3, 4, computeFingerprint("4")),
				);
				yield* waitFor(() => {
					expect(sent).toContainEqual(resync);
				});
				expect(seen).toEqual([Pending, ready(1000, "1000", 1000)]);

				yield* pubsub.publish(snapshot("scoreLeft", 4, 4));
				yield* pubsub.publish(
					delta("scoreLeft", "5", 4, 5, computeFingerprint("5")),
				);
				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						ready(1000, "1000", 1000),
						ready(4, "4", 4),
						ready(5, "5", 5),
					]);
				});
			}),
		),
	);

	test(
		"resyncs when an applied delta's fingerprint mismatches the server's",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* pubsub.publish(snapshot("scoreLeft", 0, 0));
				// Send wrong fingerprint
				yield* pubsub.publish(
					delta("scoreLeft", "5", 0, 1, computeFingerprint("9")),
				);
				yield* waitFor(() => {
					expect(sent).toContainEqual(resync);
				});
				expect(seen).toEqual([Pending, ready(0, "0", 0)]);

				yield* pubsub.publish(snapshot("scoreLeft", 9, 1));
				yield* waitFor(() => {
					expect(seen).toEqual([Pending, ready(0, "0", 0), ready(9, "9", 1)]);
				});
			}),
		),
	);

	test(
		"requests another resync when the snapshot answering the previous one does not decode",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});
				yield* pubsub.publish(snapshot("scoreLeft", 0, 0));

				const resyncs = () => sent.filter((m) => m._tag === "resync").length;
				const gappedDelta = () =>
					delta("scoreLeft", "9", 99, 100, computeFingerprint("9"));

				yield* pubsub.publish(gappedDelta());
				yield* waitFor(() => {
					expect(resyncs()).toBe(1);
				});

				yield* pubsub.publish(snapshot("scoreLeft", "not a number", 100));
				yield* pubsub.publish(gappedDelta());
				yield* waitFor(() => {
					expect(resyncs()).toBe(2);
				});

				yield* pubsub.publish(snapshot("scoreLeft", 7, 100));
				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						ready(0, "0", 0),
						Loadable.Failure({
							error: expect.objectContaining({
								_tag: "FieldUnavailable",
								namespace: "match",
								name: "scoreLeft",
								detail: expect.stringContaining(
									"published value did not decode",
								),
							}),
						}),
						ready(7, "7", 100),
					]);
				});
			}),
		),
	);

	test(
		"requests one resync however many gapped deltas arrive before the snapshot",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = yield* cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const { seen } = observe(cell.signal);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});
				yield* pubsub.publish(snapshot("scoreLeft", 0, 0));

				const resyncs = () => sent.filter((m) => m._tag === "resync").length;
				const gapped = (baseRevision: number, revision: number) =>
					delta(
						"scoreLeft",
						String(revision),
						baseRevision,
						revision,
						computeFingerprint(String(revision)),
					);

				yield* pubsub.publish(gapped(50, 51));
				yield* waitFor(() => {
					expect(resyncs()).toBe(1);
				});
				yield* pubsub.publish(gapped(51, 52));
				yield* pubsub.publish(gapped(52, 53));
				yield* pubsub.publish(gapped(53, 54));
				yield* pubsub.publish(snapshot("scoreLeft", 54, 54));
				yield* waitFor(() => {
					expect(seen).toEqual([
						Pending,
						ready(0, "0", 0),
						ready(54, "54", 54),
					]);
				});
				expect(resyncs()).toBe(1);
			}),
		),
	);
});
