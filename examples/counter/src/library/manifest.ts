import { defineNamespace } from "@nodecg/core";
import { Schema } from "effect";

const publicRead = { read: { allow: ["public"] } } as const;

export const counterManifest = defineNamespace("counter", {
	roles: {
		operator: { permission: ["state-write"] },
	},
	state: {
		count: { schema: Schema.Number, permission: publicRead },
	},
});

export const settingsManifest = defineNamespace("settings", {
	roles: {
		operator: { permission: ["state-write"] },
	},
	state: {
		title: { schema: Schema.String, permission: publicRead },
	},
});
