import { loadExtendedNamespace, loadNodecg } from "@nodecg/server";

import { counterImplemented, settingsImplemented } from "./library/server.ts";
import { extendedCounterManifest } from "./manifest.ts";

const counter = await loadExtendedNamespace(
	extendedCounterManifest,
	counterImplemented,
	{
		seedState: { step: () => 1 },
		implementComputed: {
			parity: (sources) => (sources.count % 2 === 0 ? "even" : "odd"),
		},
	},
	{
		frontend: {
			dir: import.meta.resolve("../dist"),
			vite: { root: import.meta.resolve("..") },
		},
	},
);

const settings = await settingsImplemented.load();

loadNodecg({
	namespaces: [counter, settings],
	dev: process.env["NODE_ENV"] !== "production",
});
