import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

export const ClientMessage = Schema.Union(
	Schema.TaggedStruct("subscribe", { topic: Schema.String }),
	Schema.TaggedStruct("ping", {}),
);
export type ClientMessage = typeof ClientMessage.Type;

export const ServerMessage = Schema.Union(Schema.TaggedStruct("pong", {}));
export type ServerMessage = typeof ServerMessage.Type;

export const PublishPayload = Schema.Struct({
	topic: Schema.String,
	value: Schema.Unknown,
});

export const NodecgApi = HttpApi.make("NodecgApi")
	.add(
		HttpApiGroup.make("Root").add(
			HttpApiEndpoint.get("root", "/").addError(HttpApiError.NotImplemented),
		),
	)
	.add(
		HttpApiGroup.make("Api")
			.add(HttpApiEndpoint.get("ping", "/api/ping").addSuccess(Schema.String))
			.add(HttpApiEndpoint.post("publish", "/api/publish").setPayload(PublishPayload)),
	);

export function mapValues<
	T extends Record<string, unknown>,
	R extends { [K in keyof T]: unknown },
>(obj: T, fn: <K extends keyof T>(value: T[K], key: K) => R[K]): R {
	const result: Partial<R> = {};
	for (const key of Object.keys(obj) as (keyof T)[]) {
		result[key] = fn(obj[key], key);
	}
	return result as R;
}
