import { Data } from "effect";

/**
 * Express status and value of cold asynchronous fields
 */
export type Loadable<T, E = unknown> = Data.TaggedEnum<{
	Pending: {};
	Ready: { readonly value: T };
	Failure: { readonly error: E };
}>;

interface LoadableDefinition extends Data.TaggedEnum.WithGenerics<2> {
	readonly taggedEnum: Loadable<this["A"], this["B"]>;
}

const loadable = Data.taggedEnum<LoadableDefinition>();

export const Pending = loadable.Pending();
export const Ready = loadable.Ready;
export const Failure = loadable.Failure;

export const isPending = loadable.$is("Pending");
export const isReady = loadable.$is("Ready");
export const isFailure = loadable.$is("Failure");

export const matchLoadable = loadable.$match;
