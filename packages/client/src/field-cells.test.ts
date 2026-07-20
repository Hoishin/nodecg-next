import { defineNamespace } from "@nodecg/core";
import {
	PublishMessage,
	type ServerMessage,
	SubscribeRejectedMessage,
} from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import { effect } from "@preact/signals-core";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { assert, describe, expect, onTestFinished, test, vi } from "vitest";

import { FieldCellsService } from "./field-cells.ts";
import { isFailure, isPending, isReady, Ready } from "./loadable.ts";
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

const publish = (name: string, value: number): ServerMessage =>
	PublishMessage.make({
		field: { type: "replicant", namespace: "match", name },
		value: String(value),
	});

const waitFor = (assertion: () => void) =>
	Effect.promise(() => vi.waitFor(assertion));

const makeCells = Layer.build(FieldCellsService.Default).pipe(
	Effect.map((context) => Context.get(context, FieldCellsService)),
);

describe("FieldCellsService", () => {
	test(
		"subscribes on the first watcher and goes Ready when a publish arrives",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const dispose = effect(() => void cell.signal.value);
				onTestFinished(() => dispose());
				yield* waitFor(() => {
					expect(
						sent.some(
							(m) => m._tag === "subscribe" && m.field.name === "scoreLeft",
						),
					).toBe(true);
				});

				yield* PubSub.publish(pubsub, publish("scoreLeft", 5));
				yield* waitFor(() => {
					expect(cell.peek()).toEqual(Ready({ value: 5 }));
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
				const cell = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const dispose1 = effect(() => void cell.signal.value);
				const dispose2 = effect(() => void cell.signal.value);
				yield* waitFor(() => {
					expect(sent.filter((m) => m._tag === "subscribe")).toHaveLength(1);
				});

				dispose1();
				expect(sent.some((m) => m._tag === "unsubscribe")).toBe(false);
				dispose2();
				yield* waitFor(() => {
					expect(
						sent.some(
							(m) => m._tag === "unsubscribe" && m.field.name === "scoreLeft",
						),
					).toBe(true);
				});
			}),
		),
	);

	test(
		"rejects a duplicate registration of the same field",
		testEffect(
			Effect.gen(function* () {
				const { channel } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				cells.replicant("match", "scoreLeft", namespace.replicant.scoreLeft);
				expect(() =>
					cells.replicant("match", "scoreLeft", namespace.replicant.scoreLeft),
				).toThrow(/already registered/);
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
				const cell = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const dispose = effect(() => void cell.signal.value);
				onTestFinished(() => dispose());
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* PubSub.publish(
					pubsub,
					SubscribeRejectedMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						reason: "forbidden",
					}),
				);

				yield* waitFor(() => {
					expect(isFailure(cell.peek())).toBe(true);
				});
				const value = cell.peek();
				assert(isFailure(value));
				expect(value.error).toBeInstanceOf(FieldPermissionDenied);
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
				const cell = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const dispose = effect(() => void cell.signal.value);
				onTestFinished(() => dispose());
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* PubSub.publish(
					pubsub,
					SubscribeRejectedMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						reason: "not-found",
					}),
				);

				yield* waitFor(() => {
					expect(isFailure(cell.peek())).toBe(true);
				});
				const value = cell.peek();
				assert(isFailure(value));
				expect(value.error).toBeInstanceOf(FieldNotFound);
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

				const dispose = effect(() => void cell.signal.value);
				onTestFinished(() => dispose());

				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* PubSub.publish(
					pubsub,
					SubscribeRejectedMessage.make({
						field: { type: "computed", namespace: "match", name: "total" },
						reason: "unavailable",
						message: "compute boom",
					}),
				);

				yield* waitFor(() => {
					expect(isFailure(cell.peek())).toBe(true);
				});
				const value = cell.peek();
				assert(isFailure(value));
				expect(value.error).toBeInstanceOf(FieldUnavailable);
				expect(value.error.message).toContain("compute boom");
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
				const cell = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const dispose1 = effect(() => void cell.signal.value);
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});
				yield* PubSub.publish(
					pubsub,
					SubscribeRejectedMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						reason: "forbidden",
					}),
				);
				yield* waitFor(() => {
					expect(isFailure(cell.peek())).toBe(true);
				});
				dispose1();

				const dispose2 = effect(() => void cell.signal.value);
				onTestFinished(() => dispose2());
				expect(isPending(cell.peek())).toBe(true);
				yield* PubSub.publish(pubsub, publish("scoreLeft", 5));
				yield* waitFor(() => {
					expect(cell.peek()).toEqual(Ready({ value: 5 }));
				});
			}),
		),
	);

	test(
		"logs and drops a publish that fails to decode, keeping the cell state",
		testEffect(
			Effect.gen(function* () {
				const { channel, pubsub, sent } = yield* makeFakeChannel;
				const cells = yield* makeCells.pipe(
					Effect.provideService(MessageChannelService, channel),
				);
				const cell = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);

				const dispose = effect(() => void cell.signal.value);
				onTestFinished(() => dispose());
				yield* waitFor(() => {
					expect(sent.some((m) => m._tag === "subscribe")).toBe(true);
				});

				yield* PubSub.publish(pubsub, publish("scoreLeft", 5));
				yield* waitFor(() => {
					expect(isReady(cell.peek())).toBe(true);
				});

				yield* PubSub.publish(
					pubsub,
					PublishMessage.make({
						field: { type: "replicant", namespace: "match", name: "scoreLeft" },
						value: "not a number",
					}),
				);
				yield* PubSub.publish(pubsub, publish("scoreLeft", 7));
				yield* waitFor(() => {
					expect(cell.peek()).toEqual(Ready({ value: 7 }));
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
				const left = cells.replicant(
					"match",
					"scoreLeft",
					namespace.replicant.scoreLeft,
				);
				const right = cells.replicant(
					"match",
					"scoreRight",
					namespace.replicant.scoreRight,
				);

				const disposeLeft = effect(() => void left.signal.value);
				const disposeRight = effect(() => void right.signal.value);
				onTestFinished(() => disposeRight());
				yield* waitFor(() => {
					expect(sent.filter((m) => m._tag === "subscribe")).toHaveLength(2);
				});

				disposeLeft();
				yield* PubSub.publish(pubsub, publish("scoreLeft", 7));
				yield* PubSub.publish(pubsub, publish("scoreRight", 9));
				yield* waitFor(() => {
					expect(right.peek()).toEqual(Ready({ value: 9 }));
				});
				expect(isPending(left.peek())).toBe(true);
			}),
		),
	);
});
