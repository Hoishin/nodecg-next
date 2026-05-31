import { loadNodecgEffect, loadState } from "@nodecg/server";
import { Effect, Fiber } from "effect";

import { fixtureManifest, initialValues } from "./fixture-state.ts";

export default async function setup() {
	const loaded = await loadState({ manifest: fixtureManifest, initialValues });
	const { promise: ready, resolve } = Promise.withResolvers<void>();
	const fiber = Effect.runFork(
		Effect.gen(function* () {
			yield* loadNodecgEffect({ states: [loaded] });
			resolve();
			yield* Effect.never;
		}).pipe(Effect.scoped),
	);
	await ready;
	return async () => {
		await Effect.runPromise(Fiber.interrupt(fiber));
	};
}
