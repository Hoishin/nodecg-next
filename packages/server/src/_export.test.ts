import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { expectTypeOf, test } from "vitest";

import {
	DrizzleSqliteRepositories,
	InMemoryTopicBroker,
	JsonFileReplicantRepository,
	loadNodeCGEffect,
	OperatingSystemService,
} from "./_export.ts";

test("loads and starts with exported layers only", () => {
	const program = Effect.gen(function* () {
		const { start } = yield* loadNodeCGEffect({ namespaces: {} });
		return yield* start;
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.mergeAll(
				JsonFileReplicantRepository,
				InMemoryTopicBroker,
				DrizzleSqliteRepositories,
			).pipe(
				Layer.provide(
					Layer.mergeAll(
						NodeServices.layer,
						NodeCrypto.layerSecureRandom,
						Reactivity.layer,
						OperatingSystemService.layer,
					),
				),
			),
		),
	);

	expectTypeOf(program).toExtend<Effect.Effect<void, unknown, never>>();
});
