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
	type Identity,
	ServerMessage,
	sessionCookieName,
	SubscribeRejectedMessage,
} from "@nodecg/internal";
import {
	Effect,
	Fiber,
	Match,
	Option,
	type ParseResult,
	Schema,
	Stream,
	SynchronizedRef,
} from "effect";
import type { JsonValue } from "type-fest";

import { resolveMachineIdentity } from "../auth/resolve-machine-identity.ts";
import {
	anonymousIdentity,
	resolveSessionIdentity,
} from "../auth/resolve-session-identity.ts";
import { FieldRegistryService } from "../field-registry.ts";
import { config } from "../server-config.ts";
import { MachineClientStoreService } from "../services/machine-client-store/machine-client-store.ts";
import type { ReplicantNotFound } from "../services/replicant-storage/replicant-storage.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));
const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));
const decodeBearerToken = Schema.decodeUnknownOption(
	Schema.TemplateLiteralParser("Bearer ", Schema.NonEmptyTrimmedString).pipe(
		Schema.transform(Schema.NonEmptyTrimmedString, {
			decode: ([, token]) => token,
			encode: (token) => ["Bearer ", token],
		}),
	),
);

export const websocketRoute = HttpApiBuilder.Router.use((router) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;

		const wsHandler = Effect.fn(function* (identity: Identity) {
			const socket = yield* HttpServerRequest.upgrade;
			const write = yield* socket.writer;
			const subscriptions = yield* SynchronizedRef.make<
				ReadonlyArray<{
					readonly field: FieldIdentifier;
					readonly fiber: Fiber.RuntimeFiber<
						void,
						ParseResult.ParseError | Socket.SocketError | ReplicantNotFound
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
							Match.when("replicant", () =>
								registry.replicant.get(field.namespace)?.get(field.name),
							),
							Match.when("computed", () =>
								registry.computed.get(field.namespace)?.get(field.name),
							),
							Match.when("topic", () =>
								registry.topic.get(field.namespace)?.get(field.name),
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
							// If there is stored value, send it immediately
							if ("getEncoded" in internal) {
								yield* internal.getEncoded().pipe(
									Effect.provideService(CurrentIdentity, identity),
									Effect.flatMap((value) => publish(field, value)),
									Effect.catchTag("FieldPermissionDenied", () =>
										send(
											SubscribeRejectedMessage.make({
												field,
												reason: "forbidden",
											}),
										),
									),
								);
							}
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
					Match.when({ _tag: "ping", kind: "ping" }, () =>
						Effect.gen(function* () {
							yield* Effect.logDebug("Received ping");
							yield* send({ _tag: "ping", kind: "pong" });
						}),
					),
					Match.when({ _tag: "ping", kind: "pong" }, () =>
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

		const requireAuth = yield* config.requireAuth;
		const sessions = yield* SessionStoreService;
		const roleStore = yield* RoleStoreService;
		const machines = yield* MachineClientStoreService;

		// TODO: keep contexts contexts, pass it to handler if needed
		const resolveSession = resolveSessionIdentity({ sessions, roleStore });
		const resolveMachine = resolveMachineIdentity({ machines });

		const catchUnexpectedError = Effect.catchAll(() =>
			Effect.succeed(HttpServerResponse.empty({ status: 500 })),
		);

		yield* router.get(
			"/ws/internal",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const cookie = Option.fromNullable(request.cookies[sessionCookieName]);
				const resolved = Option.isSome(cookie)
					? yield* resolveSession(cookie.value)
					: Option.none();
				if (Option.isNone(resolved) && requireAuth) {
					return HttpServerResponse.empty({ status: 401 });
				}
				const identity = Option.getOrElse(resolved, () => anonymousIdentity);
				return yield* wsHandler(identity);
			}).pipe(catchUnexpectedError),
		);

		yield* router.get(
			"/ws/v0",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const bearer = Option.fromNullable(
					request.headers["authorization"],
				).pipe(Option.flatMap(decodeBearerToken));
				const resolved = Option.isSome(bearer)
					? yield* resolveMachine(bearer.value)
					: Option.none();
				if (Option.isNone(resolved)) {
					return HttpServerResponse.empty({ status: 401 });
				}
				return yield* wsHandler(resolved.value);
			}).pipe(catchUnexpectedError),
		);
	}),
);
