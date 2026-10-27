import { defineNamespace } from "@nodecg-next/core";
import { Schema } from "effect";

export const nestAssetsManifest = defineNamespace("e2e-nest-assets", {
	replicant: {
		files: {
			schema: Schema.Finite,
			permission: { read: { everyone: "allow" } },
		},
	},
});

export const nestManifest = defineNamespace("e2e-nest", {
	children: { assets: nestAssetsManifest },
});
