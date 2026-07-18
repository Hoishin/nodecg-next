import { testEffect } from "@nodecg/internal/test-utils";
import { Chunk, Effect, Exit, Option, Scope, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { InMemoryReplicantStorage } from "./in-memory-replicant-storage.ts";
import { ReplicantStorageService } from "./replicant-storage.ts";

describe("read", () => {
	test(
		"fails with ReplicantNotFound on a missing key",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				const error = yield* storage.read("ns", "missing").pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantNotFound");
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);
});

describe("create", () => {
	test(
		"stores new values that read returns (creating the namespace)",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "a", 1);
				yield* storage.create("ns", "b", "two");
				expect(yield* storage.read("ns", "a")).toBe(1);
				expect(yield* storage.read("ns", "b")).toBe("two");
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"fails with ReplicantAlreadyExists when the key already exists",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "a", 1);
				const error = yield* storage.create("ns", "a", 2).pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantAlreadyExists");
				expect(yield* storage.read("ns", "a")).toBe(1);
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);
});

describe("update", () => {
	test(
		"overwrites an existing value",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "a", 1);
				yield* storage.update("ns", "a", 2);
				expect(yield* storage.read("ns", "a")).toBe(2);
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"fails with ReplicantNotFound on a missing key",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				const error = yield* storage.update("ns", "x", 1).pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantNotFound");
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);
});

describe("subscribe", () => {
	test(
		"emits a ReplicantChange when update succeeds",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "a", 1);
				const stream = yield* storage.subscribe();

				yield* storage.update("ns", "a", 2);

				const head = yield* Stream.runHead(stream).pipe(Effect.flatten);
				expect(head).toEqual({
					namespace: "ns",
					name: "a",
					value: 2,
				});
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"emits on create but not on a failed update",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				const stream = yield* storage.subscribe();

				yield* storage.create("ns", "a", 1);
				yield* storage.update("missing-ns", "x", 99).pipe(Effect.flip);
				yield* storage.update("ns", "a", 2);

				const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
				expect(Chunk.toArray(events)).toEqual([
					{ namespace: "ns", name: "a", value: 1 },
					{ namespace: "ns", name: "a", value: 2 },
				]);
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"delivers events to multiple concurrent subscribers",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "a", 0);
				const a = yield* storage.subscribe();
				const b = yield* storage.subscribe();

				yield* storage.update("ns", "a", 7);

				const expected = { namespace: "ns", name: "a", value: 7 };
				const headA = yield* Stream.runHead(a).pipe(Effect.flatten);
				const headB = yield* Stream.runHead(b).pipe(Effect.flatten);
				expect(headA).toEqual(expected);
				expect(headB).toEqual(expected);
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"releases a subscription when its scope closes, leaving others intact",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.create("ns", "a", 0);
				const scope = yield* Scope.make();
				const scopedPull = yield* storage
					.subscribe()
					.pipe(Scope.extend(scope), Effect.flatMap(Stream.toPull));
				const otherPull = yield* storage
					.subscribe()
					.pipe(Effect.flatMap(Stream.toPull));

				yield* storage.update("ns", "a", 1);
				const expected1 = { namespace: "ns", name: "a", value: 1 };
				expect(Chunk.toArray(yield* scopedPull)).toEqual([expected1]);
				expect(Chunk.toArray(yield* otherPull)).toEqual([expected1]);

				yield* Scope.close(scope, Exit.void);

				yield* storage.update("ns", "a", 2);
				expect(Chunk.toArray(yield* otherPull)).toEqual([
					{ namespace: "ns", name: "a", value: 2 },
				]);

				const scopedEnd = yield* scopedPull.pipe(Effect.flip);
				expect(Option.isNone(scopedEnd)).toBe(true);
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);
});
