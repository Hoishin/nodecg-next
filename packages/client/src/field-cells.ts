import type { FieldManifest } from "@nodecg/core";
import {
	type ClientMessage,
	type ComputedFieldIdentifier,
	type FieldIdentifier,
	type FieldValueMessage,
	type PublishMessage,
	type ReplicantDeltaMessage,
	type ReplicantFieldIdentifier,
	type ReplicantSnapshotMessage,
	ResyncMessage,
	SubscribeMessage,
	type TopicFieldIdentifier,
	UnsubscribeMessage,
} from "@nodecg/internal";
import { applyPatch, computeFingerprint } from "@nodecg/internal/occ";
import { setSignal, type SetSignalError } from "@nodecg/internal/utils";
import { type Signal, signal } from "@preact/signals-core";
import {
	Data,
	Effect,
	Either,
	Mailbox,
	Match,
	MutableHashMap,
	Option,
	Ref,
	Stream,
} from "effect";
import type { JsonValue } from "type-fest";

import {
	Cold,
	type ComputedLoadable,
	type ComputedValue,
	Loadable,
	ReadyLoadableValue,
	Pending,
	type ReplicantLoadable,
	type ReplicantValue,
	type TopicLoadable,
	type TopicValue,
} from "./loadable.ts";
import {
	FieldNotFound,
	FieldPermissionDenied,
	FieldUnavailable,
} from "./services/field-transport/field-transport.ts";
import { MessageChannelService } from "./services/message-channel/message-channel.ts";

export type TerminalFieldFailure = FieldNotFound | FieldPermissionDenied;
export type FieldFailure = TerminalFieldFailure | FieldUnavailable;

const fieldKey = <Field extends FieldIdentifier>(field: Field) =>
	Data.struct(field);

const isCold = Loadable.$is("Cold");

export interface ReplicantCell<Decoded> {
	readonly signal: Signal<ReplicantLoadable<Decoded, FieldFailure>>;
	readonly peek: () => ReplicantLoadable<Decoded, FieldFailure>;
}

export interface ComputedCell<Decoded> {
	readonly signal: Signal<ComputedLoadable<Decoded, FieldFailure>>;
	readonly peek: () => ComputedLoadable<Decoded, FieldFailure>;
}

export interface TopicCell<Decoded> {
	readonly signal: Signal<TopicLoadable<Decoded, FieldFailure>>;
	readonly peek: () => TopicLoadable<Decoded, FieldFailure>;
}

// Forks two fibers: sender (client -> server) and pump (server -> client), both interrupted when the scope closes.
export class FieldCellsService extends Effect.Service<FieldCellsService>()(
	"FieldCells",
	{
		scoped: Effect.gen(function* () {
			const channel = yield* MessageChannelService;
			const outbound = yield* Mailbox.make<ClientMessage>();

			interface CellHandlers<Message> {
				readonly applyFrame: (
					frame: Message,
				) => Effect.Effect<void, SetSignalError>;
				readonly reject: (
					reason: "forbidden" | "not-found" | "unavailable",
					message: string | undefined,
				) => Effect.Effect<void, SetSignalError>;
			}

			type ReplicantPublish = ReplicantSnapshotMessage | ReplicantDeltaMessage;
			const replicantHandlers = MutableHashMap.empty<
				ReplicantFieldIdentifier,
				CellHandlers<ReplicantPublish>
			>();

			const computedHandlers = MutableHashMap.empty<
				ComputedFieldIdentifier,
				CellHandlers<FieldValueMessage>
			>();

			const topicHandlers = MutableHashMap.empty<
				TopicFieldIdentifier,
				CellHandlers<FieldValueMessage>
			>();

			const makeRejectionError = (
				namespace: string,
				name: string,
				reason: "forbidden" | "not-found" | "unavailable",
				message: string | undefined,
			) =>
				Match.value(reason).pipe(
					Match.when("not-found", () => new FieldNotFound({ namespace, name })),
					Match.when(
						"forbidden",
						() => new FieldPermissionDenied({ namespace, name }),
					),
					Match.when(
						"unavailable",
						() => new FieldUnavailable({ namespace, name, detail: message }),
					),
					Match.exhaustive,
				);

			const makeCell = <V extends ReadyLoadableValue<unknown>>(
				field: FieldIdentifier,
			) => {
				const cell = signal<Loadable<V, FieldFailure>>(Cold, {
					watched: () => {
						cell.value = Pending;
						outbound.unsafeOffer(SubscribeMessage.make({ field }));
					},
					unwatched: () => {
						// Cold drops the base with the value, so nothing stale can be read back
						cell.value = Cold;
						outbound.unsafeOffer(UnsubscribeMessage.make({ field }));
					},
				});
				return cell;
			};

			const makeReject =
				<V extends ReadyLoadableValue<unknown>>(
					cell: Signal<Loadable<V, FieldFailure>>,
					field: FieldIdentifier,
				): CellHandlers<unknown>["reject"] =>
				(reason, message) =>
					isCold(cell.peek())
						? Effect.void
						: setSignal(
								cell,
								Loadable.Failure({
									error: makeRejectionError(
										field.namespace,
										field.name,
										reason,
										message,
									),
								}),
							);

			const makeReplicantCell = Effect.fn("makeReplicantCell")(function* <
				Decoded,
			>(namespace: string, name: string, manifest: FieldManifest<Decoded>) {
				const field: ReplicantFieldIdentifier = {
					type: "replicant",
					namespace,
					name,
				};
				const cell = makeCell<ReplicantValue<Decoded>>(field);

				const resyncing = yield* Ref.make(false);
				const requestResync = Effect.gen(function* () {
					const wasResyncing = yield* Ref.getAndSet(resyncing, true);
					if (wasResyncing) {
						return;
					}
					yield* outbound.offer(ResyncMessage.make({ field }));
				});

				const decodeIntoCell = (encoded: JsonValue, revision: number) =>
					manifest.decode(encoded).pipe(
						Effect.flatMap((decoded) =>
							setSignal(
								cell,
								Loadable.Ready({
									value: ReadyLoadableValue.Replicant({
										decoded,
										encoded,
										revision,
									}),
								}),
							),
						),
						Effect.catchTag("FieldDecodeError", (error) =>
							setSignal(
								cell,
								Loadable.Failure({
									error: new FieldUnavailable({
										namespace,
										name,
										detail: `published value did not decode: ${error.message}`,
									}),
								}),
							),
						),
					);

				const applyDeltaToCell = (delta: ReplicantDeltaMessage) =>
					Loadable.$match(cell.peek(), {
						Cold: () => Effect.void,
						Pending: () => Effect.void,
						Failure: () => requestResync,
						Ready: ({ value: current }) =>
							Effect.gen(function* () {
								if (
									delta.baseRevision !== current.revision ||
									delta.revision <= current.revision
								) {
									return yield* requestResync;
								}
								const applied = applyPatch(current.encoded, delta.ops);
								if (Either.isLeft(applied)) {
									yield* Effect.logWarning(
										`Delta for "${namespace}/${name}" did not apply, resyncing:`,
										applied.left,
									);
									return yield* requestResync;
								}
								if (computeFingerprint(applied.right) !== delta.hash) {
									yield* Effect.logWarning(
										`Delta for "${namespace}/${name}" diverged from the server fingerprint, resyncing`,
									);
									return yield* requestResync;
								}
								yield* decodeIntoCell(applied.right, delta.revision);
							}),
					});

				MutableHashMap.set(replicantHandlers, fieldKey(field), {
					applyFrame: (frame) =>
						Effect.gen(function* () {
							if (isCold(cell.peek())) {
								return;
							}
							yield* Match.value(frame).pipe(
								Match.tag("snapshot", (snapshot) =>
									Effect.gen(function* () {
										yield* Ref.set(resyncing, false);
										yield* decodeIntoCell(snapshot.value, snapshot.revision);
									}),
								),
								Match.tag("delta", applyDeltaToCell),
								Match.exhaustive,
							);
						}),
					reject: makeReject(cell, field),
				});

				return { signal: cell, peek: () => cell.peek() };
			});

			const makeComputedCell = <Decoded>(
				namespace: string,
				name: string,
				manifest: FieldManifest<Decoded>,
			): ComputedCell<Decoded> => {
				const field: ComputedFieldIdentifier = {
					type: "computed",
					namespace,
					name,
				};
				const cell = makeCell<ComputedValue<Decoded>>(field);

				MutableHashMap.set(computedHandlers, fieldKey(field), {
					applyFrame: (published) =>
						Effect.gen(function* () {
							if (isCold(cell.peek())) {
								return;
							}
							yield* manifest.decode(published.value).pipe(
								Effect.flatMap((decoded) =>
									setSignal(
										cell,
										Loadable.Ready({
											value: ReadyLoadableValue.Computed({ decoded }),
										}),
									),
								),
								Effect.catchTag("FieldDecodeError", (error) =>
									setSignal(
										cell,
										Loadable.Failure({
											error: new FieldUnavailable({
												namespace,
												name,
												detail: `published value did not decode: ${error.message}`,
											}),
										}),
									),
								),
							);
						}),
					reject: makeReject(cell, field),
				});

				return { signal: cell, peek: () => cell.peek() };
			};

			const makeTopicCell = <Decoded>(
				namespace: string,
				name: string,
				manifest: FieldManifest<Decoded>,
			): TopicCell<Decoded> => {
				const field: TopicFieldIdentifier = { type: "topic", namespace, name };
				const cell = makeCell<TopicValue<Decoded>>(field);

				MutableHashMap.set(topicHandlers, fieldKey(field), {
					applyFrame: (published) =>
						Effect.gen(function* () {
							if (isCold(cell.peek())) {
								return;
							}
							yield* manifest.decode(published.value).pipe(
								Effect.flatMap((decoded) =>
									setSignal(
										cell,
										Loadable.Ready({
											value: ReadyLoadableValue.Topic({ decoded }),
										}),
									),
								),
								Effect.catchTag("FieldDecodeError", (error) =>
									setSignal(
										cell,
										Loadable.Failure({
											error: new FieldUnavailable({
												namespace,
												name,
												detail: `published value did not decode: ${error.message}`,
											}),
										}),
									),
								),
							);
						}),
					reject: makeReject(cell, field),
				});

				return { signal: cell, peek: () => cell.peek() };
			};

			// Sender: drain mailbox and send changes to server
			yield* Effect.forkScoped(
				Mailbox.toStream(outbound).pipe(
					Stream.runForEach((message) =>
						channel
							.send(message)
							.pipe(
								Effect.catchTag("MessageEncodeError", (error) =>
									Effect.logError(
										`Failed to send "${message._tag}" message:`,
										error,
									),
								),
							),
					),
				),
			);

			const incoming = yield* channel.receive();

			const applyFrameToCell = <Key, Message extends PublishMessage>(
				registered: MutableHashMap.MutableHashMap<Key, CellHandlers<Message>>,
				key: Key,
				frame: Message,
			) =>
				Effect.gen(function* () {
					const handler = MutableHashMap.get(registered, key);
					if (Option.isSome(handler)) {
						yield* handler.value
							.applyFrame(frame)
							.pipe(
								Effect.catchTag("SetSignalError", (error) =>
									Effect.logError(
										`A watcher of "${frame.field.namespace}/${frame.field.name}" threw:`,
										error,
									),
								),
							);
					}
				});

			// Pump: server messages handler
			yield* Effect.forkScoped(
				Stream.runForEach(incoming, (message) =>
					Match.value(message).pipe(
						Match.tag("snapshot", "delta", (published) =>
							applyFrameToCell(replicantHandlers, fieldKey(published.field), published),
						),
						Match.tag("value", (published) =>
							Match.value(published.field).pipe(
								Match.when({ type: "computed" }, (field) =>
									applyFrameToCell(computedHandlers, fieldKey(field), published),
								),
								Match.when({ type: "topic" }, (field) =>
									applyFrameToCell(topicHandlers, fieldKey(field), published),
								),
								Match.exhaustive,
							),
						),
						Match.tag("subscribe-rejected", (rejected) =>
							Effect.gen(function* () {
								const handler = Match.value(rejected.field).pipe(
									Match.when({ type: "replicant" }, (field) =>
										MutableHashMap.get(replicantHandlers, fieldKey(field)),
									),
									Match.when({ type: "computed" }, (field) =>
										MutableHashMap.get(computedHandlers, fieldKey(field)),
									),
									Match.when({ type: "topic" }, (field) =>
										MutableHashMap.get(topicHandlers, fieldKey(field)),
									),
									Match.exhaustive,
								);
								if (Option.isSome(handler)) {
									yield* handler.value
										.reject(rejected.reason, rejected.message)
										.pipe(
											Effect.catchTag("SetSignalError", (error) =>
												Effect.logError(
													`A watcher of "${rejected.field.namespace}/${rejected.field.name}" threw:`,
													error,
												),
											),
										);
								}
							}),
						),
						Match.tag("ping", () => Effect.void),
						Match.exhaustive,
					),
				),
			);

			return {
				replicant: makeReplicantCell,
				computed: makeComputedCell,
				topic: makeTopicCell,
			};
		}),
	},
) {}
