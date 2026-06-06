import { loadNamespace, type StateFieldPromise } from "@nodecg/client";
import { StrictMode, Suspense, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";

import { counterManifest } from "./state.ts";

const counter = await loadNamespace(counterManifest);

type Snapshot<T> = { readonly value: T };

interface StateFieldSyncStore<T> {
	subscribe: (onStoreChange: () => void) => () => void;
	getSnapshot: () => Snapshot<T> | undefined;
	ready: () => Promise<void>;
}

const toSyncStore = <T,>(
	stateField: StateFieldPromise<T>,
): StateFieldSyncStore<T> => {
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
			started = stateField.subscribe(publish).then(() =>
				stateField.get().then((value) => {
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
const useCount = () => {
	const snapshot = useSyncExternalStore(
		countStore.subscribe,
		countStore.getSnapshot,
	);
	if (typeof snapshot === "undefined") {
		throw countStore.ready();
	}
	return snapshot.value;
};

function Counter() {
	const value = useCount();
	return (
		<div>
			<p>count = {value}</p>
			<button
				type="button"
				//  TODO: proper async handling. maybe with tanstack query
				onClick={() => counter.state.count.update((v) => v + 1)}
			>
				+1
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
