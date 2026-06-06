import { loadNamespace, loadNodecg } from "@nodecg/server";

import { fixtureManifest } from "./fixture-state.ts";

const loaded = await loadNamespace(fixtureManifest, {
	seedState: {
		count: () => 0,
		label: () => "hello",
	},
	implementComputed: {
		doubledCount: (sources: { count: number }) => sources.count * 2,
		summary: (sources: { count: number; label: string }) =>
			sources.count > 0 ? `${sources.label} x${sources.count}` : "idle",
	},
});

loadNodecg({
	namespaces: [loaded],
	onReady: () => {
		if (typeof process.send === "undefined") {
			throw new Error("start-server.ts must be spawned with an IPC channel");
		}
		process.send("ready");
	},
});
