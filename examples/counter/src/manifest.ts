import { extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

import { counterManifest } from "./library/manifest.ts";

export const extendedCounterManifest = extendNamespace(counterManifest, {
	state: {
		step: { schema: Schema.Number },
	},
	computed: {
		parity: { schema: Schema.Literal("even", "odd") },
	},
});
