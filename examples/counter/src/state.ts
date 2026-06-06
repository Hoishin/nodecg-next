import { defineNamespace } from "@nodecg/core";
import { Schema } from "effect";

export const counterManifest = defineNamespace("counter", {
	state: {
		count: { schema: Schema.Number },
	},
});
