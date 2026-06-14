import { StrictMode, Suspense } from "react";

import { counter, mount, useField } from "./store.tsx";

function Graphics() {
	const count = useField(counter.state.count);
	const parity = useField(counter.computed.parity);
	return (
		<div style={{ fontSize: "6rem", fontFamily: "sans-serif" }}>
			{count} <small style={{ fontSize: "2rem" }}>({parity})</small>
		</div>
	);
}

mount(
	<StrictMode>
		<Suspense fallback="Loading...">
			<Graphics />
		</Suspense>
	</StrictMode>,
);
