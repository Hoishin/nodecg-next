import { computed, effect } from "@preact/signals-core";
import { Equal } from "effect";

import {
	Failure,
	isReady,
	type Loadable,
	matchLoadable,
	Pending,
	Ready,
} from "./loadable.ts";

/**
 * React Suspense-like thrown value to resolve asynchronous values read in derive functions
 */
const SUSPENDED: unique symbol = Symbol("client/suspended");

const isSuspended = (e: unknown): e is typeof SUSPENDED => e === SUSPENDED;

export const fieldSource: unique symbol = Symbol("client/field-source");

export interface FieldSource<T> {
	readonly [fieldSource]: { readonly value: Loadable<T> };
}

/**
 * Synchronously read the current value of a field with suspense mechanism
 */
export type Get = <T>(source: FieldSource<T>) => T;

const getAccessor: Get = (source) => {
	const value = source[fieldSource].value;
	switch (value._tag) {
		case "Ready":
			return value.value;
		case "Failure":
			throw value.error;
		case "Pending":
			throw SUSPENDED;
	}
};

export interface DerivedHandle<T> extends FieldSource<T> {
	readonly get: () => Promise<T>;
	readonly subscribe: (
		listener: (value: T) => void,
		onError?: (error: unknown) => void,
	) => () => void;
}

/**
 * Client-local reactive value calculated from other fields
 */
export const derive = <T>(
	compute: (get: Get) => T,
	options?: { readonly equals?: (a: T, b: T) => boolean },
): DerivedHandle<T> => {
	const equals = options?.equals;
	const same = (a: Loadable<T>, b: Loadable<T>): boolean =>
		equals && isReady(a) && isReady(b)
			? equals(a.value, b.value)
			: Equal.equals(a, b);

	let last: Loadable<T> | undefined;
	const derived = computed<Loadable<T>>(() => {
		let next: Loadable<T>;
		try {
			next = Ready({ value: compute(getAccessor) });
		} catch (error) {
			// Catch SUSPENDED value and propagate as Pending, which makes it wait for next update
			next = isSuspended(error) ? Pending : Failure({ error });
		}
		if (typeof last !== "undefined" && same(last, next)) {
			return last;
		}
		last = next;
		return next;
	});

	const get = () =>
		new Promise<T>((resolve, reject) => {
			const settle = (value: Loadable<T>): boolean =>
				matchLoadable(value, {
					Ready: ({ value }) => {
						resolve(value);
						return true;
					},
					Failure: ({ error }) => {
						reject(error);
						return true;
					},
					Pending: () => false,
				});
			if (settle(derived.peek())) {
				return;
			}
			// Setup reactive effect only when value isn't ready
			const dispose = effect(() => {
				if (settle(derived.value)) {
					dispose();
				}
			});
		});

	const subscribe = (
		listener: (value: T) => void,
		onError?: (error: unknown) => void,
	) =>
		effect(() => {
			matchLoadable(derived.value, {
				Ready: ({ value }) => listener(value),
				Failure: ({ error }) => onError?.(error),
				Pending: () => {},
			});
		});

	return { get, subscribe, [fieldSource]: derived };
};
