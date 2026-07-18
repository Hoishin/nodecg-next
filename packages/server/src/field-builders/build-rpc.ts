import type { RpcFieldManifest } from "@nodecg/core";
import { toError } from "@nodecg/internal/utils";
import { Data, Effect } from "effect";
import type { JsonValue, Promisable } from "type-fest";

import { fieldInternal } from "./field-internal-key.ts";
import { requirePermission } from "./permission.ts";

export class RpcCallFailed extends Data.TaggedError("RpcCallFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `RPC handler for "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export const buildRpc = Effect.fn("buildRpc")(
	<Request, Response, Ctx = unknown>(
		namespace: string,
		name: string,
		manifest: RpcFieldManifest<Request, Response>,
		handler: (request: Request, ctx: Ctx) => Promisable<Response>,
		ctx: Ctx,
	) =>
		Effect.sync(() => {
			const runHandler = (request: Request) =>
				Effect.tryPromise({
					try: async () => handler(request, ctx),
					catch: (error) =>
						new RpcCallFailed({ namespace, name, cause: toError(error) }),
				});

			const call = Effect.fn("call")(function* (request: Request) {
				yield* requirePermission(manifest.permission, namespace, name, "write");
				return yield* runHandler(request);
			});

			const callEncoded = Effect.fn("callEncoded")(function* (
				payload: JsonValue,
			) {
				yield* requirePermission(manifest.permission, namespace, name, "write");
				const request = yield* manifest.request.decode(payload);
				const response = yield* runHandler(request);
				return yield* manifest.response.encode(response);
			});

			return {
				call,
				[fieldInternal]: {
					callEncoded,
					permission: manifest.permission,
				},
			};
		}),
);

export type RpcFieldEffect<Request, Response> = Effect.Effect.Success<
	ReturnType<typeof buildRpc<Request, Response>>
>;
