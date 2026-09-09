import { testLayer } from "@nodecg-next/test-utils";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { InMemoryReplicantStorage } from "./in-memory-replicant-storage.ts";
import { ReplicantStorageService } from "./replicant-storage.ts";

const test = testLayer(InMemoryReplicantStorage);

describe("read", () => {
	test(
		"fails with ReplicantNotFound on a missing key",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const error = yield* storage.read("ns", "missing").pipe(Effect.flip);
			expect(error._tag).toBe("ReplicantNotFound");
		}),
	);
});

describe("write", () => {
	test(
		"createIfNotFound stores new values that read returns",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			yield* storage.write("ns", "a", 1, true);
			yield* storage.write("ns", "b", "two", true);
			expect(yield* storage.read("ns", "a")).toBe(1);
			expect(yield* storage.read("ns", "b")).toBe("two");
		}),
	);

	test(
		"fails with ReplicantNotFound on a missing key without createIfNotFound",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const error = yield* storage.write("ns", "x", 1).pipe(Effect.flip);
			expect(error._tag).toBe("ReplicantNotFound");
		}),
	);

	test(
		"overwrites an existing value",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			yield* storage.write("ns", "a", 1, true);
			yield* storage.write("ns", "a", 2);
			expect(yield* storage.read("ns", "a")).toBe(2);
		}),
	);
});
