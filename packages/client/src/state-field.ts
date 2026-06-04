import type { PromisifyObject } from "@nodecg/internal";
import { Data, type Effect, type Scope, type Stream } from "effect";
import type { Promisable } from "type-fest";

export class GetStateError extends Data.TaggedError("GetStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause}`;
	}
}

export class UpdateStateError extends Data.TaggedError("UpdateStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: Error;
}> {
	override get message() {
		return `Failed to update state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
	}
}

export class StateSubscriptionError extends Data.TaggedError(
	"StateSubscriptionError",
)<{
	readonly cause: Error;
}> {
	override get message() {
		return `State subscription failed: ${this.cause.message}`;
	}
}

export interface StateFieldEffect<Decoded> {
	get: () => Effect.Effect<Decoded, GetStateError>;
	set: (value: Decoded) => Effect.Effect<void, UpdateStateError>;
	update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<void, UpdateStateError>;
	subscribe: () => Effect.Effect<
		Stream.Stream<Decoded>,
		StateSubscriptionError,
		Scope.Scope
	>;
}

export type StateFieldPromise<Decoded> = Omit<
	PromisifyObject<StateFieldEffect<Decoded>>,
	"subscribe"
> & {
	subscribe: (
		callback: (value: Decoded) => Promisable<void>,
	) => Promise<() => void>;
};

export interface ComputedFieldEffect<Decoded> {
	get: () => Effect.Effect<Decoded, GetStateError>;
	subscribe: () => Effect.Effect<
		Stream.Stream<Decoded>,
		StateSubscriptionError,
		Scope.Scope
	>;
}

export type ComputedFieldPromise<Decoded> = Omit<
	PromisifyObject<ComputedFieldEffect<Decoded>>,
	"subscribe"
> & {
	subscribe: (
		callback: (value: Decoded) => Promisable<void>,
	) => Promise<() => void>;
};
