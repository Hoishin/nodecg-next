import { defineNamespace } from "@nodecg/core";
import { Schema } from "effect";

export const fixtureManifest = defineNamespace("e2e", {
	state: {
		count: { schema: Schema.Number },
		label: { schema: Schema.String },
	},
	computed: {
		doubledCount: { schema: Schema.Number },
		summary: { schema: Schema.String },
	},
});
