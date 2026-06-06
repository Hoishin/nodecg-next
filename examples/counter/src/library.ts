import { defineNamespace } from "@nodecg/core";
import { implementNamespace } from "@nodecg/server";
import { Schema } from "effect";

export const counterManifest = defineNamespace("counter", {
	state: {
		count: { schema: Schema.Number },
	},
});

export const counterImplemented = implementNamespace(counterManifest, {
	seedState: { count: () => 0 },
});
