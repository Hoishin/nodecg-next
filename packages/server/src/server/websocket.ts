import {
	HttpApiBuilder,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
	type Socket,
} from "@effect/platform";
import type { FieldEncodeError } from "@nodecg/core";
import {
	ClientMessage,
	type ComputedFieldIdentifier,
	type FieldIdentifier,
	FieldValueMessage,
	type Identity,
	PingMessage,
	ReplicantDeltaMessage,
	type ReplicantFieldIdentifier,
	ReplicantSnapshotMessage,
	ServerMessage,
	sessionCookieName,
	SubscribeRejectedMessage,
	type TopicFieldIdentifier,
} from "@nodecg/internal";
import {
	Data,
	Effect,
	Fiber,
	HashMap,
	Match,
	Option,
	type ParseResult,
	Schema,
	Stream,
	SynchronizedRef,
} from "effect";

import { resolveMachineIdentity } from "../auth/resolve-machine-identity.ts";
import {
	anonymousIdentity,
	resolveSessionIdentity,
} from "../auth/resolve-session-identity.ts";
import {
	type ComputedComputeError,
	type ComputedNotFound,
	DerivationEngineService,
	type ReplicantFrame,
	type UnknownReplicant,
} from "../derivation-graph.ts";
import type { FieldPermissionDenied } from "../field-builders/permission.ts";
import {
	type ComputedFieldInternal,
	FieldRegistryService,
	type ReplicantFieldInternal,
	type TopicFieldInternal,
} from "../field-registry.ts";
import { config } from "../server-config.ts";
import { MachineClientStoreService } from "../services/machine-client-store/machine-client-store.ts";
import type { ReplicantNotFound } from "../services/replicant-storage/replicant-storage.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
import { TopicBrokerService } from "../services/topic-broker/topic-broker.ts";

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

type SubscribeFailure =
	| FieldPermissionDenied
	| ComputedComputeError
	| ReplicantNotFound
	| UnknownReplicant
	| FieldEncodeError
	| ComputedNotFound
	| ParseResult.ParseError
	| Socket.SocketError;

type ResolvedField = Data.TaggedEnum<{
	Replicant: {
		readonly field: ReplicantFieldIdentifier;
		readonly internal: ReplicantFieldInternal;
	};
	Computed: {
		readonly field: ComputedFieldIdentifier;
		readonly internal: ComputedFieldInternal;
	};
	Topic: {
		readonly field: TopicFieldIdentifier;
		readonly internal: TopicFieldInternal;
	};
}>;
const ResolvedField = Data.taggedEnum<ResolvedField>();

const fieldKey = (field: FieldIdentifier) => Data.struct(field);

export const websocketRoute = HttpApiBuilder.Router.use((router) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;

		const resolveField = (field: FieldIdentifier) =>
			Match.value(field).pipe(
				Match.when({ type: "replicant" }, (replicantField) =>
					Option.fromNullable(
						registry.replicant
							.get(replicantField.namespace)
							?.get(replicantField.name),
					).pipe(
						Option.map((internal) =>
							ResolvedField.Replicant({ field: replicantField, internal }),
						),
					),
				),
				Match.when({ type: "computed" }, (computedField) =>
					Option.fromNullable(
						registry.computed
							.get(computedField.namespace)
							?.get(computedField.name),
					).pipe(
						Option.map((internal) =>
							ResolvedField.Computed({ field: computedField, internal }),
						),
					),
				),
				Match.when({ type: "topic" }, (topicField) =>
					Option.fromNullable(
						registry.topic.get(topicField.namespace)?.get(topicField.name),
					).pipe(
						Option.map((internal) =>
							ResolvedField.Topic({ field: topicField, internal }),
						),
					),
				),
				Match.exhaustive,
			);

		const wsHandler = Effect.fn(function* (identity: Identity) {
			const socket = yield* HttpServerRequest.upgrade;
			const write = yield* socket.writer;

			const send = (msg: ServerMessage) =>
				encodeServerMessage(msg).pipe(
					Effect.andThen((encodedMessage) => write(encodedMessage)),
				);

			const rejectSubscribeFailure = (field: FieldIdentifier) => {
				const rejectUnavailable = (error: { readonly message: string }) =>
					send(
						SubscribeRejectedMessage.make({
							field,
							reason: "unavailable",
							message: error.message,
						}),
					);
				return <A, R>(effect: Effect.Effect<A, SubscribeFailure, R>) =>
					effect.pipe(
						Effect.catchTags({
							FieldPermissionDenied: () =>
								send(
									SubscribeRejectedMessage.make({ field, reason: "forbidden" }),
								),
							ComputedComputeError: rejectUnavailable,
							ReplicantNotFound: rejectUnavailable,
							UnknownReplicant: rejectUnavailable,
							FieldEncodeError: rejectUnavailable,
							ComputedNotFound: () =>
								send(
									SubscribeRejectedMessage.make({ field, reason: "not-found" }),
								),
						}),
					);
			};

			const replicantFrameMessage = (
				field: ReplicantFieldIdentifier,
				frame: ReplicantFrame,
			) =>
				Option.match(frame.delta, {
					onNone: () =>
						ReplicantSnapshotMessage.make({
							field,
							value: frame.value,
							revision: frame.revision,
						}),
					onSome: (delta) =>
						ReplicantDeltaMessage.make({
							field,
							ops: delta.ops,
							baseRevision: delta.baseRevision,
							revision: frame.revision,
							hash: delta.hash,
						}),
				});

			const openSubscription = Effect.fn("openSubscription")(function* (
				field: FieldIdentifier,
			) {
				const resolved = resolveField(field);
				if (Option.isNone(resolved)) {
					yield* send(
						SubscribeRejectedMessage.make({ field, reason: "not-found" }),
					);
					return Option.none();
				}
				const target = resolved.value;
				if (!target.internal.permission.canRead(identity)) {
					yield* send(
						SubscribeRejectedMessage.make({ field, reason: "forbidden" }),
					);
					return Option.none();
				}

				const fiber = yield* Effect.forkScoped(
					Match.value(target)
						.pipe(
							Match.tag("Replicant", ({ field, internal }) =>
								Effect.gen(function* () {
									const frames = yield* internal.subscribeRevisioned();
									yield* Stream.runForEach(frames, (frame) =>
										send(replicantFrameMessage(field, frame)),
									);
								}),
							),
							Match.tag("Computed", "Topic", ({ field, internal }) =>
								Effect.gen(function* () {
									const stream = yield* internal.subscribeEncoded();
									yield* Stream.runForEach(stream, (value) =>
										send(FieldValueMessage.make({ field, value })),
									);
								}),
							),
							Match.exhaustive,
						)
						.pipe(Effect.scoped, rejectSubscribeFailure(field)),
				);
				return Option.some(fiber);
			});

			const subscriptions = yield* SynchronizedRef.make(
				HashMap.empty<
					FieldIdentifier,
					Fiber.RuntimeFiber<void, ParseResult.ParseError | Socket.SocketError>
				>(),
			);

			yield* socket.runRaw(
				Effect.fn(function* (data: string | Uint8Array) {
					if (typeof data !== "string") {
						return;
					}
					const message = yield* decodeClientMessage(data);
					yield* Match.value(message).pipe(
						Match.tag("ping", (msg) =>
							Match.value(msg).pipe(
								Match.when({ kind: "ping" }, () =>
									Effect.gen(function* () {
										yield* Effect.logDebug("Received ping");
										yield* send(PingMessage.make({ kind: "pong" }));
									}),
								),
								Match.when({ kind: "pong" }, () =>
									Effect.logDebug("Received pong"),
								),
								Match.exhaustive,
							),
						),
						Match.tag("subscribe", (msg) =>
							SynchronizedRef.updateEffect(subscriptions, (map) =>
								Effect.gen(function* () {
									const key = fieldKey(msg.field);
									const existing = HashMap.get(map, key);
									// Restart subscription for fresh reseed if already running
									if (Option.isSome(existing)) {
										yield* Fiber.interrupt(existing.value);
									}
									const fiber = yield* openSubscription(msg.field);
									return HashMap.modifyAt(map, key, () => fiber);
								}),
							),
						),
						Match.tag("resync", (msg) =>
							SynchronizedRef.updateEffect(subscriptions, (map) =>
								Effect.gen(function* () {
									const key = fieldKey(msg.field);
									const existing = HashMap.get(map, key);
									// Ignore if not subscribed
									if (Option.isNone(existing)) {
										return map;
									}
									yield* Fiber.interrupt(existing.value);
									const fiber = yield* openSubscription(msg.field);
									return HashMap.modifyAt(map, key, () => fiber);
								}),
							),
						),
						Match.tag("unsubscribe", (msg) =>
							SynchronizedRef.updateEffect(subscriptions, (map) =>
								Effect.gen(function* () {
									const key = fieldKey(msg.field);
									const existing = HashMap.get(map, key);
									if (Option.isNone(existing)) {
										return map;
									}
									yield* Fiber.interrupt(existing.value);
									return HashMap.remove(map, key);
								}),
							),
						),
						Match.exhaustive,
					);
				}),
			);
			return HttpServerResponse.empty();
		});

		const requireAuth = yield* config.requireAuth;
		const sessions = yield* SessionStoreService;
		const roleStore = yield* RoleStoreService;
		const machines = yield* MachineClientStoreService;
		const broker = yield* TopicBrokerService;
		const engine = yield* DerivationEngineService;

		// TODO: keep contexts contexts, pass it to handler if needed
		const resolveSession = resolveSessionIdentity({ sessions, roleStore });
		const resolveMachine = resolveMachineIdentity({ machines });

		const ws = HttpRouter.empty.pipe(
			HttpRouter.get(
				"/ws/internal",
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const cookie = Option.fromNullable(
						request.cookies[sessionCookieName],
					);
					const resolved = Option.isSome(cookie)
						? yield* resolveSession(cookie.value)
						: Option.none();
					if (Option.isNone(resolved) && requireAuth) {
						return HttpServerResponse.empty({ status: 401 });
					}
					const identity = Option.getOrElse(resolved, () => anonymousIdentity);
					return yield* wsHandler(identity);
				}),
			),
			HttpRouter.get(
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
				}),
			),
			HttpRouter.provideService(TopicBrokerService, broker),
			HttpRouter.provideService(DerivationEngineService, engine),
		);

		yield* router.concat(ws);
	}),
);
