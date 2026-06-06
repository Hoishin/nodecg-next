import { extendNamespace } from "@nodecg/core";
import { loadExtendedNamespace } from "@nodecg/server";
import { Schema } from "effect";

import { counterImplemented, counterManifest } from "./library";

export const extendedCounterManifest = extendNamespace(counterManifest, {
	state: {
		step: { schema: Schema.Number },
	},
	computed: {
		parity: { schema: Schema.Literal("even", "odd") },
	},
});

export const counter = await loadExtendedNamespace(
	extendedCounterManifest,
	counterImplemented,
	{
		seedState: { step: () => 1 },
		implementComputed: {
			parity: (sources) => (sources.count % 2 === 0 ? "even" : "odd"),
		},
	},
);
