import { loadNodecg, loadState } from "@nodecg/server";

import { fixtureManifest, initialValues } from "./fixture-state.ts";

const loaded = await loadState({ manifest: fixtureManifest, initialValues });

loadNodecg({
	states: [loaded],
	onReady: () => {
		if (typeof process.send === "undefined") {
			throw new Error("start-server.ts must be spawned with an IPC channel");
		}
		process.send("ready");
	},
});
