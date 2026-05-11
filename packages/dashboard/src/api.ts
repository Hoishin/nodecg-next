import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { NodecgApi } from "@nodecg/internal";
import { Effect } from "effect";

export const apiClient = Effect.runPromise(
	HttpApiClient.make(NodecgApi, { baseUrl: "/" }).pipe(
		Effect.provide(FetchHttpClient.layer),
	),
);
