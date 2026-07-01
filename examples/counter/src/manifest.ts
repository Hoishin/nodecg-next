import { extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

import { counterManifest } from "./library/manifest.ts";

export const extendedCounterManifest = extendNamespace(counterManifest, {
	state: {
		step: {
			schema: Schema.Number,
			permission: { read: { allow: ["public"] } },
		},
	},
	computed: {
		parity: {
			schema: Schema.Literal("even", "odd"),
			permission: { read: { allow: ["public"] } },
		},
	},
});
