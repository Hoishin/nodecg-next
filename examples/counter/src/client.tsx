import { loadNamespace } from "@nodecg/client";
import { StrictMode, Suspense, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";

import { extendedCounterManifest } from "./app.ts";

const counter = await loadNamespace(extendedCounterManifest);

type Snapshot<T> = { readonly value: T };

// state and computed fields both expose get + subscribe — enough to drive a sync store.
interface ReadableField<T> {
	get: () => Promise<T>;
	subscribe: (callback: (value: T) => void) => Promise<() => void>;
}

interface FieldSyncStore<T> {
	subscribe: (onStoreChange: () => void) => () => void;
	getSnapshot: () => Snapshot<T> | undefined;
	ready: () => Promise<void>;
}

const toSyncStore = <T,>(field: ReadableField<T>): FieldSyncStore<T> => {
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

const countStore = toSyncStore(counter.state.count);
const stepStore = toSyncStore(counter.state.step);
const parityStore = toSyncStore(counter.computed.parity);

const useField = <T,>(store: FieldSyncStore<T>): T => {
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	if (typeof snapshot === "undefined") {
		throw store.ready();
	}
	return snapshot.value;
};

function Counter() {
	const count = useField(countStore);
	const step = useField(stepStore);
	const parity = useField(parityStore);
	return (
		<div>
			<p>
				count = {count} ({parity})
			</p>
			<p>step = {step}</p>
			<button
				type="button"
				// TODO: proper async handling. maybe with tanstack query
				onClick={() => counter.state.count.update((value) => value + step)}
			>
				+{step}
			</button>
			<button
				type="button"
				onClick={() => counter.state.step.update((value) => value + 1)}
			>
				step +1
			</button>
		</div>
	);
}

const rootElement = document.getElementById("app");
if (rootElement === null) {
	throw new Error("#app not found");
}
ReactDOM.createRoot(rootElement).render(
	<StrictMode>
		<Suspense fallback="Loading...">
			<Counter />
		</Suspense>
	</StrictMode>,
);
