import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
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

describe("write", () => {
	test(
		"createIfNotFound stores new values that read returns",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.write("ns", "a", 1, true);
				yield* storage.write("ns", "b", "two", true);
				expect(yield* storage.read("ns", "a")).toBe(1);
				expect(yield* storage.read("ns", "b")).toBe("two");
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"fails with ReplicantNotFound on a missing key without createIfNotFound",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				const error = yield* storage.write("ns", "x", 1).pipe(Effect.flip);
				expect(error._tag).toBe("ReplicantNotFound");
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);

	test(
		"overwrites an existing value",
		testEffect(
			Effect.gen(function* () {
				const storage = yield* ReplicantStorageService;
				yield* storage.write("ns", "a", 1, true);
				yield* storage.write("ns", "a", 2);
				expect(yield* storage.read("ns", "a")).toBe(2);
			}).pipe(Effect.provide(InMemoryReplicantStorage)),
		),
	);
});
