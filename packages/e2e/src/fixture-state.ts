import { defineNamespace, extendNamespace } from "@nodecg/core";
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

export const baseManifest = defineNamespace("e2e-extend", {
	state: {
		score: { schema: Schema.Number },
	},
});

export const extendedManifest = extendNamespace(baseManifest, {
	state: {
		bonus: { schema: Schema.Number },
	},
	computed: {
		total: { schema: Schema.Number },
	},
});
