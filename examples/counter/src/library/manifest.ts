import { defineNamespace } from "@nodecg/core";
import { Schema } from "effect";

export const counterManifest = defineNamespace("counter", {
	state: {
		count: { schema: Schema.Number },
	},
});

export const settingsManifest = defineNamespace("settings", {
	state: {
		title: { schema: Schema.String },
	},
});
