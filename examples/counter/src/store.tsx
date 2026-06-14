import {
	loadNamespace,
	type ComputedField,
	type StateField,
} from "@nodecg/client";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";

import { extendedCounterManifest } from "./manifest.ts";

export const counter = await loadNamespace(extendedCounterManifest);

type Snapshot<T> = { readonly value: T };

interface FieldSyncStore<T> {
	subscribe: (onStoreChange: () => void) => () => void;
	getSnapshot: () => Snapshot<T> | undefined;
	ready: () => Promise<void>;
}

const toSyncStore = <T,>(
	field: StateField<T> | ComputedField<T>,
): FieldSyncStore<T> => {
	let snapshot: Snapshot<T> | undefined;
	let started: Promise<void> | undefined;
	const listeners = new Set<() => void>();

	const publish = (value: T) => {
		snapshot = { value };
		for (const listener of listeners) {
			listener();
		}
	};

	const ready = () => {
		if (typeof started === "undefined") {
			started = field.subscribe(publish).then(() =>
				field.get().then((value) => {
					if (typeof snapshot === "undefined") {
						publish(value);
					}
				}),
			);
		}
		return started;
	};

	return {
		ready,
		subscribe(onStoreChange) {
			listeners.add(onStoreChange);
			void ready();
			return () => {
				listeners.delete(onStoreChange);
			};
		},
		getSnapshot: () => snapshot,
	};
};

const StoresStore = new WeakMap<
	StateField<unknown> | ComputedField<unknown>,
	FieldSyncStore<unknown>
>();

function getStore<T>(
	field: StateField<T> | ComputedField<T>,
): FieldSyncStore<T> {
	if (StoresStore.has(field)) {
		return StoresStore.get(field) as FieldSyncStore<T>;
	}
	const store = toSyncStore(field);
	StoresStore.set(field, store);
	return store;
}

export function useField<T>(field: StateField<T> | ComputedField<T>): T {
	const [syncStore] = useState(() => getStore(field));
	const snapshot = useSyncExternalStore(
		syncStore.subscribe,
		syncStore.getSnapshot,
	);
	if (typeof snapshot === "undefined") {
		throw syncStore.ready();
	}
	return snapshot.value;
}

export const mount = (node: ReactNode) => {
	const rootElement = document.getElementById("app");
	if (rootElement === null) {
		throw new Error("#app not found");
	}
	ReactDOM.createRoot(rootElement).render(node);
};
