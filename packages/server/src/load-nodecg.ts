import { createServer } from "node:http";

import {
	HttpApiBuilder,
	HttpApiError,
	HttpApp,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { ClientMessage, NodecgApi, ServerMessage } from "@nodecg/internal";
import { Effect, Layer, Match, Schema } from "effect";

import { stateMetadataKey } from "./load-state";
import {
	type StateField,
	type StateFieldPromise,
	stateFieldInternal,
} from "./models/state-field";

type LoadedState = Record<
	string,
	StateField<unknown> | StateFieldPromise<unknown>
> & {
	[stateMetadataKey]: { namespace: string };
};

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));
const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));

const handleMessage = (
	msg: ClientMessage,
	send: (msg: ServerMessage) => Effect.Effect<void, unknown>,
) =>
	Match.value(msg).pipe(
		Match.tag("subscribe", ({ topic }) => Effect.log(`sub: ${topic}`)),
		Match.tag("ping", () => send({ _tag: "pong" })),
		Match.exhaustive,
	);

const wsHandler = Effect.gen(function* () {
	const socket = yield* HttpServerRequest.upgrade;
	const write = yield* socket.writer;
	const send = (msg: ServerMessage) =>
		encodeServerMessage(msg).pipe(Effect.flatMap(write));
	yield* socket.runRaw((data) =>
		typeof data === "string"
			? decodeClientMessage(data).pipe(
					Effect.flatMap((msg) => handleMessage(msg, send)),
				)
			: Effect.void,
	);
	return HttpServerResponse.empty();
});

const wsMiddleware = (apiApp: HttpApp.Default) =>
	Effect.gen(function* () {
		const req = yield* HttpServerRequest.HttpServerRequest;
		if (new URL(req.url, "http://x").pathname === "/ws") {
			return yield* wsHandler.pipe(
				Effect.catchAll(() =>
					Effect.succeed(HttpServerResponse.empty({ status: 500 })),
				),
			);
		}
		return yield* apiApp;
	});

export const loadNodecg = (options: { states: ReadonlyArray<LoadedState> }) => {
	const registry = new Map<
		string,
		Map<string, StateField<unknown> | StateFieldPromise<unknown>>
	>();
	for (const state of options.states) {
		const { namespace } = state[stateMetadataKey];
		const fields = registry.get(namespace) ?? new Map();
		for (const [name, field] of Object.entries(state)) {
			fields.set(name, field);
		}
		registry.set(namespace, fields);
	}

	const HealthGroupLive = HttpApiBuilder.group(
		NodecgApi,
		"Health",
		(handlers) => handlers.handle("ping", () => Effect.succeed("pong")),
	);

	const StateGroupLive = HttpApiBuilder.group(NodecgApi, "State", (handlers) =>
		handlers
			.handle("get", ({ path: { namespace, name } }) =>
				Effect.gen(function* () {
					const field = registry.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					return yield* field[stateFieldInternal].get().pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tag("StateNotFound", () => new HttpApiError.NotFound()),
								Match.tag(
									"StateGetFailed",
									() => new HttpApiError.InternalServerError(),
								),
								Match.tag(
									"StateValidationError",
									() => new HttpApiError.InternalServerError(),
								),
								Match.exhaustive,
							),
						),
					);
				}),
			)
			.handle("update", ({ path: { namespace, name }, payload }) =>
				Effect.gen(function* () {
					const field = registry.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					yield* field[stateFieldInternal].setEncoded(payload).pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tag(
									"StateValidationError",
									() => new HttpApiError.BadRequest(),
								),
								Match.tag("StateNotFound", () => new HttpApiError.NotFound()),
								Match.tag(
									"StateSaveFailed",
									() => new HttpApiError.InternalServerError(),
								),
								Match.exhaustive,
							),
						),
					);
				}),
			),
	);

	const NodecgApiLive = HttpApiBuilder.api(NodecgApi).pipe(
		Layer.provide(HealthGroupLive),
		Layer.provide(StateGroupLive),
	);

	const ServerLive = HttpApiBuilder.serve(wsMiddleware).pipe(
		Layer.provide(NodecgApiLive),
		Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
	);

	return Layer.launch(ServerLive);
};
