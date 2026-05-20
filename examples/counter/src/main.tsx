import { loadState } from "@nodecg/client/load-state";
import { StrictMode, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { counterState } from "./state.ts";

const counter = await loadState({ manifest: counterState });

function Counter() {
	const [value, setValue] = useState<number | null>(null);

	useEffect(() => {
		let unsubscribe: (() => void) | undefined;
		counter.count.getValue().then(setValue).catch(console.error);
		counter.count
			.subscribe(setValue)
			.then((u) => {
				unsubscribe = u;
			})
			.catch(console.error);
		return () => {
			unsubscribe?.();
		};
	}, []);

	return (
		<div>
			<p>count = {value ?? "…"}</p>
			<button
				type="button"
				onClick={() => counter.count.update((v) => v + 1)}
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
		<Counter />
	</StrictMode>,
);
