import { loadState } from "@nodecg/client";
import { StrictMode, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { counterState } from "./state.ts";

const counter = await loadState({ manifest: counterState });

function Counter() {
	const [value, setValue] = useState<number | null>(null);

	useEffect(() => {
		counter.count.get().then(setValue).catch(console.error);
		return counter.count.subscribe(setValue);
	}, []);

	return (
		<div>
			<p>count = {value ?? "…"}</p>
			<button type="button" onClick={() => counter.count.update((v) => v + 1)}>
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
