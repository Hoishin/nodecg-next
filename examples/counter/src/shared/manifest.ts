import { extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

import { counterManifest } from "./library/manifest.ts";

export const extendedCounterManifest = extendNamespace(counterManifest, {
	replicant: {
		step: {
			schema: Schema.Number,
			permission: { read: { everyone: "allow" } },
		},
	},
	computed: {
		parity: {
			schema: Schema.Literal("even", "odd"),
			permission: { read: { everyone: "allow" } },
		},
		announcement: {
			schema: Schema.String,
			permission: { read: { everyone: "allow" } },
		},
	},
});
