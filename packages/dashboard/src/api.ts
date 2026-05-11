import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { NodecgApi, PublishPayload } from "@nodecg/internal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Effect } from "effect";

const apiClientPromise = Effect.runPromise(
	HttpApiClient.make(NodecgApi, { baseUrl: "/" }).pipe(
		Effect.provide(FetchHttpClient.layer),
	),
);

export const usePing = () =>
	useQuery({
		queryKey: ["ping"],
		queryFn: async () => Effect.runPromise((await apiClientPromise).Api.ping()),
	});

export const usePublish = () =>
	useMutation({
		mutationFn: async (payload: typeof PublishPayload.Type) =>
			Effect.runPromise((await apiClientPromise).Api.publish({ payload })),
	});
