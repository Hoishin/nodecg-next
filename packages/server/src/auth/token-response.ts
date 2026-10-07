import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { CustomFetchOptions } from "openid-client";

const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
export type UnknownRecord = typeof recordSchema.Type;

const decodeRecord = Schema.decodeUnknownEffect(recordSchema);
const encodeJsonRecord = Schema.encodeEffect(
	Schema.fromJsonString(recordSchema),
);

export const makeTokenResponseFetch = Effect.fn("makeTokenResponseFetch")(
	function* (transform: (body: UnknownRecord) => UnknownRecord) {
		const context = yield* Effect.context<HttpClient.HttpClient>();
		return (url: string, options: CustomFetchOptions) =>
			Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient;
				const response = yield* client.execute(
					HttpClientRequest.fromWeb(new Request(url, options)),
				);
				const body = yield* decodeRecord(yield* response.json);
				const headers = new Headers(response.headers);
				// Should rather remove than being incorrect
				headers.delete("content-length");
				return new Response(yield* encodeJsonRecord(transform(body)), {
					status: response.status,
					headers,
				});
			}).pipe(Effect.runPromiseWith(context));
	},
);
