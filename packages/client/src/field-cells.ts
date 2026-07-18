import type { FieldManifest } from "@nodecg/core";
import type { ClientMessage, FieldIdentifier } from "@nodecg/internal";
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
import type { JsonValue } from "type-fest";

import { Failure, type Loadable, Pending, Ready } from "./loadable.ts";
import {
	FieldNotFound,
	FieldPermissionDenied,
	FieldUnavailable,
} from "./services/field-transport/field-transport.ts";
import { MessageChannelService } from "./services/message-channel/message-channel.ts";

export type FieldFailure =
	| FieldNotFound
	| FieldPermissionDenied
	| FieldUnavailable;

/**
 * Field read/write container on top of signal
 */
export interface FieldCell<Decoded> {
	readonly signal: Signal<Loadable<Decoded, FieldFailure>>;
	readonly peek: () => Loadable<Decoded, FieldFailure>;
	readonly reflect: (value: Decoded) => void;
}

export interface FieldCells {
	readonly replicant: <Decoded>(
		namespace: string,
		name: string,
		manifest: FieldManifest<Decoded>,
	) => FieldCell<Decoded>;
	readonly computed: <Decoded>(
		namespace: string,
		name: string,
		manifest: FieldManifest<Decoded>,
	) => FieldCell<Decoded>;
	readonly topic: <Decoded>(
		namespace: string,
		name: string,
		manifest: FieldManifest<Decoded>,
	) => FieldCell<Decoded>;
}

// Data.struct gives the key structural equality (Hash/Equal), so distinct
// fields can't collide the way a delimiter-joined string could
const fieldKey = (field: FieldIdentifier) => Data.struct(field);
type FieldKey = ReturnType<typeof fieldKey>;

// Forks two fibers: sender (client -> server) and pump (server -> client), both interrupted when the scope closes.
export class FieldCellsService extends Effect.Service<FieldCellsService>()(
	"FieldCells",
	{
		scoped: Effect.gen(function* () {
			const channel = yield* MessageChannelService;
			const outbound = yield* Mailbox.make<ClientMessage>();

			interface CellHandlers {
				readonly valueChange: (value: JsonValue) => Effect.Effect<void>;
				readonly reject: (
					reason: "forbidden" | "not-found" | "unavailable",
					message: string | undefined,
				) => Effect.Effect<void>;
			}
			const handlers = MutableHashMap.empty<FieldKey, CellHandlers>();

			const cellFor = <Decoded>(
				type: FieldIdentifier["type"],
				namespace: string,
				name: string,
				manifest: FieldManifest<Decoded>,
			): FieldCell<Decoded> => {
				const field: FieldIdentifier = { type, namespace, name };
				const key = fieldKey(field);
				if (MutableHashMap.has(handlers, key)) {
					throw new Error(
						`field "${type} ${namespace}/${name}" is already registered`,
					);
				}

				let hot = false;
				const cell = signal<Loadable<Decoded, FieldFailure>>(Pending, {
					watched: () => {
						hot = true;
						outbound.unsafeOffer({ _tag: "subscribe", field });
					},
					unwatched: () => {
						// Immediately reject incoming updates to prevent overwriting Pending with live data
						hot = false;
						cell.value = Pending;
						outbound.unsafeOffer({ _tag: "unsubscribe", field });
					},
				});

				MutableHashMap.set(handlers, key, {
					valueChange: (value) =>
						manifest.decode(value).pipe(
							Effect.map((decoded) => {
								// dropped if the field went cold while we were decoding
								if (hot) {
									cell.value = Ready({ value: decoded });
								}
							}),
							Effect.catchAll((error) =>
								Effect.logError(
									`Failed to decode published value for "${namespace}/${name}":`,
									error,
								),
							),
						),
					reject: (reason, message) =>
						Effect.sync(() => {
							if (!hot) {
								return;
							}
							const error = Match.value(reason).pipe(
								Match.when(
									"not-found",
									() => new FieldNotFound({ namespace, name }),
								),
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
							cell.value = Failure({ error });
						}),
				});

				return {
					signal: cell,
					peek: () => cell.peek(),
					reflect: (value) => {
						if (hot) {
							cell.value = Ready({ value });
						}
					},
				};
			};

			// Sender: drain mailbox and send changes to server
			yield* Effect.forkScoped(
				Mailbox.toStream(outbound).pipe(
					Stream.runForEach((message) =>
						channel
							.send(message)
							.pipe(
								Effect.catchAll((error) =>
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
						Match.tag("publish", (published) =>
							Effect.gen(function* () {
								const handler = Option.getOrUndefined(
									MutableHashMap.get(handlers, fieldKey(published.field)),
								);
								if (handler) {
									yield* handler.valueChange(published.value);
								}
							}),
						),
						Match.tag("subscribe-rejected", (rejected) =>
							Effect.gen(function* () {
								const handler = Option.getOrUndefined(
									MutableHashMap.get(handlers, fieldKey(rejected.field)),
								);
								if (handler) {
									yield* handler.reject(rejected.reason, rejected.message);
								}
							}),
						),
						Match.orElse(() => Effect.void),
					),
				),
			);

			const cells: FieldCells = {
				replicant: (namespace, name, manifest) =>
					cellFor("replicant", namespace, name, manifest),
				computed: (namespace, name, manifest) =>
					cellFor("computed", namespace, name, manifest),
				topic: (namespace, name, manifest) =>
					cellFor("topic", namespace, name, manifest),
			};
			return cells;
		}),
	},
) {}
