import { testEffect } from "@nodecg/internal/test-utils";
import { Effect, Option, Redacted } from "effect";
import { assert, describe, expect, test } from "vitest";

import { InMemoryMachineClientStore } from "./in-memory-machine-client-store.ts";
import { MachineClientStoreService } from "./machine-client-store.ts";

describe("createApiKey", () => {
	test(
		"returns an ncg-prefixed token and a distinct id per key",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const a = yield* machines.createApiKey({ displayName: "Bot A" });
				const b = yield* machines.createApiKey({ displayName: "Bot B" });
				expect(Redacted.value(a.token)).toMatch(/^ncg_/);
				expect(a.id).not.toBe(b.id);
				expect(Redacted.value(a.token)).not.toBe(Redacted.value(b.token));
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});

describe("validateApiKey", () => {
	test(
		"resolves a created token to its client",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const resolved = yield* machines.validateApiKey(
					Redacted.value(created.token),
				);
				assert(Option.isSome(resolved));
				expect(resolved.value).toEqual({ id: created.id, displayName: "Bot" });
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"returns None for an unknown token",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				expect(Option.isNone(yield* machines.validateApiKey("ncg_ghost"))).toBe(
					true,
				);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});
