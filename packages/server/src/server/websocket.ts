import {
	HttpApiBuilder,
	HttpServerRequest,
	HttpServerResponse,
	type Socket,
} from "@effect/platform";
import {
	ClientMessage,
	CurrentIdentity,
	type FieldIdentifier,
	fieldIdentifierEquivalence,
	PublicIdentitySchema,
	ServerMessage,
	SubscribeRejectedMessage,
} from "@nodecg/internal";
import {
	Effect,
	Fiber,
	Match,
	type ParseResult,
	Schema,
	Stream,
	SynchronizedRef,
} from "effect";
import type { JsonValue } from "type-fest";

import { buildFieldRegistry } from "../field-registry.ts";
import type { LoadedNamespace } from "../load-namespace.ts";
import type { StateNotFound } from "../services/state-storage/state-storage.ts";

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));
const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));

export const websocketRoute = (options: {
	namespaces: ReadonlyArray<LoadedNamespace>;
}) => {
	const registry = buildFieldRegistry(options.namespaces);

	const wsHandler = Effect.gen(function* () {
		const socket = yield* HttpServerRequest.upgrade;
		const write = yield* socket.writer;
		// TODO: resolve identity from the WS handshake session cookie (04 §7); anonymous until then
		const identity = PublicIdentitySchema.make();
		const subscriptions = yield* SynchronizedRef.make<
			ReadonlyArray<{
				readonly field: FieldIdentifier;
				readonly fiber: Fiber.RuntimeFiber<
					void,
					ParseResult.ParseError | Socket.SocketError | StateNotFound
				>;
			}>
		>([]);

		const send = (msg: ServerMessage) =>
			encodeServerMessage(msg).pipe(
				Effect.andThen((encodedMessage) => write(encodedMessage)),
			);

		const publish = (field: FieldIdentifier, value: JsonValue) =>
			send({ _tag: "publish", field, value });

		const startSubscription = (field: FieldIdentifier) =>
			SynchronizedRef.updateEffect(subscriptions, (list) =>
				Effect.gen(function* () {
					const internal = Match.value(field.type).pipe(
						Match.when("state", () =>
							registry.state.get(field.namespace)?.get(field.name),
						),
						Match.when("computed", () =>
							registry.computed.get(field.namespace)?.get(field.name),
						),
						Match.exhaustive,
					);
					if (typeof internal === "undefined") {
						yield* send(
							SubscribeRejectedMessage.make({ field, reason: "not-found" }),
						);
						return list;
					}
					if (list.some((s) => fieldIdentifierEquivalence(s.field, field))) {
						yield* internal.getEncoded().pipe(
							Effect.provideService(CurrentIdentity, identity),
							Effect.flatMap((value) => publish(field, value)),
							Effect.catchTag("PermissionDenied", () =>
								send(
									SubscribeRejectedMessage.make({ field, reason: "forbidden" }),
								),
							),
						);
						return list;
					}
					if (!internal.permission.canRead(identity)) {
						yield* send(
							SubscribeRejectedMessage.make({ field, reason: "forbidden" }),
						);
						return list;
					}
					const fiber = yield* Effect.forkScoped(
						Effect.gen(function* () {
							const stream = yield* internal.subscribeEncoded();
							yield* Stream.runForEach(stream, (value) =>
								publish(field, value),
							);
						}).pipe(Effect.scoped),
					);
					return [...list, { field, fiber }];
				}),
			);

		const stopSubscription = (field: FieldIdentifier) =>
			SynchronizedRef.updateEffect(subscriptions, (list) =>
				Effect.gen(function* () {
					const match = list.find((s) =>
						fieldIdentifierEquivalence(s.field, field),
					);
					if (typeof match === "undefined") {
						return list;
					}
					yield* Fiber.interrupt(match.fiber);
					return list.filter(
						(s) => !fieldIdentifierEquivalence(s.field, field),
					);
				}),
			);

		const handleMessage = (msg: ClientMessage) =>
			Match.value(msg).pipe(
				Match.when({ _tag: "ping", topic: "ping" }, () =>
					Effect.gen(function* () {
						yield* Effect.logDebug("Received ping");
						yield* send({ _tag: "ping", topic: "pong" });
					}),
				),
				Match.when({ _tag: "ping", topic: "pong" }, () =>
					Effect.logDebug("Received pong"),
				),
				Match.when({ _tag: "subscribe" }, (msg) =>
					startSubscription(msg.field),
				),
				Match.when({ _tag: "unsubscribe" }, (msg) =>
					stopSubscription(msg.field),
				),
				Match.exhaustive,
			);

		yield* socket.runRaw((data) =>
			typeof data === "string"
				? decodeClientMessage(data).pipe(Effect.flatMap(handleMessage))
				: Effect.void,
		);
		return HttpServerResponse.empty();
	});

	return HttpApiBuilder.Router.use((router) =>
		router.get(
			"/ws",
			wsHandler.pipe(
				Effect.catchAll(() =>
					Effect.succeed(HttpServerResponse.empty({ status: 500 })),
				),
			),
		),
	);
};
