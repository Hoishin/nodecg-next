import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "@effect/platform";
import { Context, Effect, Layer, Match } from "effect";
import type { JsonValue } from "type-fest";

import {
	StateGetFailed,
	StateNotFound,
	StateSaveFailed,
	StateTransportService,
} from "./state-transport";

export function createHttpStateTransport(): Context.Tag.Service<
	typeof StateTransportService
> {
	const get = Effect.fn("StateTransport.get")(function* (
		namespace: string,
		name: string,
	) {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.get(`/api/namespaces/${namespace}/state/${name}`)
			.pipe(
				Effect.mapError(
					(error) =>
						new StateGetFailed({
							namespace,
							name,
							cause: new Error(error.message),
						}),
				),
			);
		return yield* HttpClientResponse.matchStatus(response, {
			"2xx": (ok) =>
				ok.json.pipe(
					Effect.mapError(
						(error) =>
							new StateGetFailed({
								namespace,
								name,
								cause: new Error(error.message),
							}),
					),
				),
			404: () => new StateNotFound({ namespace, name }),
			orElse: (bad) =>
				new StateGetFailed({
					namespace,
					name,
					cause: new Error(`unexpected response status ${bad.status}`),
				}),
		});
	}, Effect.provide(FetchHttpClient.layer));

	const update = Effect.fn("StateTransport.update")(function* (
		namespace: string,
		name: string,
		value: JsonValue,
	) {
		const client = yield* HttpClient.HttpClient;
		const response = yield* HttpClientRequest.put(
			`/api/namespaces/${namespace}/state/${name}`,
		).pipe(
			HttpClientRequest.bodyJson(value),
			Effect.andThen(client.execute),
			Effect.mapError((error) => {
				const message = Match.value(error).pipe(
					Match.tag(
						"HttpBodyError",
						(e) => `failed to encode body (${e.reason._tag})`,
					),
					Match.tag("RequestError", "ResponseError", (e) => e.message),
					Match.exhaustive,
				);
				return new StateSaveFailed({
					namespace,
					name,
					cause: new Error(message),
				});
			}),
		);
		return yield* HttpClientResponse.matchStatus(response, {
			"2xx": () => Effect.void,
			404: () => new StateNotFound({ namespace, name }),
			orElse: (bad) =>
				new StateSaveFailed({
					namespace,
					name,
					cause: new Error(`unexpected response status ${bad.status}`),
				}),
		});
	}, Effect.provide(FetchHttpClient.layer));

	return { get, update };
}

export const HttpStateTransport = Layer.sync(StateTransportService, () =>
	createHttpStateTransport(),
);
