import { defineNamespace } from "@nodecg/core";
import { Schema } from "effect";

const publicRead = { read: { allow: ["public"] } } as const;
const publicReadWrite = {
	read: { allow: ["public"] },
	write: { allow: ["public"] },
} as const;
const publicWrite = { write: { allow: ["public"] } } as const;

export const counterManifest = defineNamespace("counter", {
	roles: {
		operator: { permission: ["state-write"] },
	},
	state: {
		count: { schema: Schema.Number, permission: publicRead },
	},
	topic: {
		cheer: { schema: Schema.String, permission: publicReadWrite },
	},
	rpc: {
		roll: {
			schema: { request: Schema.Number, response: Schema.Number },
			permission: publicWrite,
		},
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
