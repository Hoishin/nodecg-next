import { extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

import { counterManifest } from "./library/manifest.ts";

export const extendedCounterManifest = extendNamespace(counterManifest, {
	replicant: {
		step: {
			schema: Schema.Number,
			permission: { read: { allow: ["everyone"] } },
		},
	},
	computed: {
		parity: {
			schema: Schema.Literal("even", "odd"),
			permission: { read: { allow: ["everyone"] } },
		},
	},
});
