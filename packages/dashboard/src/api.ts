import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { NodecgApi } from "@nodecg/internal";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";

const apiClient = Effect.runSync(
	HttpApiClient.make(NodecgApi, { baseUrl: "/" }).pipe(
		Effect.provide(FetchHttpClient.layer),
	),
);

export const usePing = () =>
	useQuery({
		queryKey: ["ping"],
		queryFn: () => Effect.runPromise(apiClient.Health.ping()),
	});
