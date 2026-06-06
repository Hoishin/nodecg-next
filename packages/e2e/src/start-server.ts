import {
	implementNamespace,
	loadExtendedNamespace,
	loadNamespace,
	loadNodecg,
} from "@nodecg/server";

import {
	baseManifest,
	extendedManifest,
	fixtureManifest,
} from "./fixture-state.ts";

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

const baseImplemented = implementNamespace(baseManifest, {
	seedState: { score: () => 0 },
});
const extended = await loadExtendedNamespace(
	extendedManifest,
	baseImplemented,
	{
		seedState: { bonus: () => 0 },
		implementComputed: {
			total: (sources) => sources.score + sources.bonus,
		},
	},
);

loadNodecg({
	namespaces: [loaded, extended],
	onReady: () => {
		if (typeof process.send === "undefined") {
			throw new Error("start-server.ts must be spawned with an IPC channel");
		}
		process.send("ready");
	},
});
