import { StrictMode, Suspense } from "react";

import { counter, mount, useField } from "./store.tsx";

function Dashboard() {
	const count = useField(counter.state.count);
	const step = useField(counter.state.step);
	const parity = useField(counter.computed.parity);
	return (
		<div>
			<h1>Counter dashboard</h1>
			<p>
				count = {count} ({parity})
			</p>
			<p>step = {step}</p>
			<button
				type="button"
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

mount(
	<StrictMode>
		<Suspense fallback="Loading...">
			<Dashboard />
		</Suspense>
	</StrictMode>,
);
