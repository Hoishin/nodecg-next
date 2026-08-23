import type { FieldManifest } from "@nodecg/core";
import {
	type ClientMessage,
	type FieldIdentifier,
	type PublishMessage,
	SubscribeMessage,
	UnsubscribeMessage,
} from "@nodecg/internal";
import { setSignal, type SetSignalError } from "@nodecg/internal/utils";
import { type Signal, signal } from "@preact/signals-core";
import {
	Data,
	Effect,
	Mailbox,
	Match,
	MutableHashMap,
	Option,
	Stream,
} from "effect";

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

const fieldKey = (field: FieldIdentifier) => Data.struct(field);

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

			interface CellHandlers {
				readonly applyFrame: (
					frame: PublishMessage,
				) => Effect.Effect<void, SetSignalError>;
				readonly reject: (
					reason: "forbidden" | "not-found" | "unavailable",
					message: string | undefined,
				) => void;
			}
			const handlers = MutableHashMap.empty<FieldIdentifier, CellHandlers>();

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

				const onFrame = (applyFrame: CellHandlers["applyFrame"]) => {
					MutableHashMap.set(handlers, fieldKey(field), {
						applyFrame: (frame) =>
							isCold(cell.peek()) ? Effect.void : applyFrame(frame),
						reject: (reason, message) => {
							if (isCold(cell.peek())) {
								return;
							}
							cell.value = Loadable.Failure({
								error: makeRejectionError(
									field.namespace,
									field.name,
									reason,
									message,
								),
							});
						},
					});
				};

				return { cell, onFrame };
			};

			const makeReplicantCell = <Decoded>(
				namespace: string,
				name: string,
				manifest: FieldManifest<Decoded>,
			): ReplicantCell<Decoded> => {
				const field: FieldIdentifier = { type: "replicant", namespace, name };
				const { cell, onFrame } = makeCell<ReplicantValue<Decoded>>(field);

				onFrame((frame) =>
					Match.value(frame).pipe(
						Match.tag("snapshot", (snapshot) =>
							manifest.decode(snapshot.value).pipe(
								Effect.flatMap((decoded) =>
									setSignal(
										cell,
										Loadable.Ready({
											value: ReadyLoadableValue.Replicant({
												decoded,
												encoded: snapshot.value,
												revision: snapshot.revision,
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
							),
						),
						Match.tag("value", () => Effect.void),
						Match.exhaustive,
					),
				);

				return { signal: cell, peek: () => cell.peek() };
			};

			const makeComputedCell = <Decoded>(
				namespace: string,
				name: string,
				manifest: FieldManifest<Decoded>,
			): ComputedCell<Decoded> => {
				const field: FieldIdentifier = { type: "computed", namespace, name };
				const { cell, onFrame } = makeCell<ComputedValue<Decoded>>(field);

				onFrame((frame) =>
					Match.value(frame).pipe(
						Match.tag("value", (published) =>
							manifest.decode(published.value).pipe(
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
							),
						),
						Match.tag("snapshot", () => Effect.void),
						Match.exhaustive,
					),
				);

				return { signal: cell, peek: () => cell.peek() };
			};

			const makeTopicCell = <Decoded>(
				namespace: string,
				name: string,
				manifest: FieldManifest<Decoded>,
			): TopicCell<Decoded> => {
				const field: FieldIdentifier = { type: "topic", namespace, name };
				const { cell, onFrame } = makeCell<TopicValue<Decoded>>(field);

				onFrame((frame) =>
					Match.value(frame).pipe(
						Match.tag("value", (published) =>
							manifest.decode(published.value).pipe(
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
							),
						),
						Match.tag("snapshot", () => Effect.void),
						Match.exhaustive,
					),
				);

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

			// Pump: server messages handler
			yield* Effect.forkScoped(
				Stream.runForEach(incoming, (message) =>
					Match.value(message).pipe(
						Match.tag("snapshot", "value", (published) =>
							Effect.gen(function* () {
								const handler = Option.getOrUndefined(
									MutableHashMap.get(handlers, fieldKey(published.field)),
								);
								if (handler) {
									yield* handler.applyFrame(published).pipe(
										Effect.catchTag("SetSignalError", (error) =>
											Effect.logError(
												`A watcher of "${published.field.namespace}/${published.field.name}" threw:`,
												error,
											),
										),
									);
								}
							}),
						),
						Match.tag("subscribe-rejected", (rejected) =>
							Effect.sync(() => {
								const handler = Option.getOrUndefined(
									MutableHashMap.get(handlers, fieldKey(rejected.field)),
								);
								if (handler) {
									handler.reject(rejected.reason, rejected.message);
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
