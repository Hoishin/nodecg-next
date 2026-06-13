import { loadExtendedNamespace, loadNodecg } from "@nodecg/server";

import { extendedCounterManifest } from "./app.ts";
import { counterImplemented, settingsImplemented } from "./library.ts";

const counter = await loadExtendedNamespace(
	extendedCounterManifest,
	counterImplemented,
	{
		seedState: { step: () => 1 },
		implementComputed: {
			parity: (sources) => (sources.count % 2 === 0 ? "even" : "odd"),
		},
	},
);

const settings = await settingsImplemented.load();

loadNodecg({ namespaces: [counter, settings] });
