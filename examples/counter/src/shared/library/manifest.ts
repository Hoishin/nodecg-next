import { defineNamespace } from "@nodecg/core";
import { Schema } from "effect";

const anonymousRead = { read: { allow: ["anonymous"] } } as const;
const anonymousReadWrite = {
	read: { allow: ["anonymous"] },
	write: { allow: ["anonymous"] },
} as const;
const anonymousWrite = { write: { allow: ["anonymous"] } } as const;

export const counterManifest = defineNamespace("counter", {
	roles: {
		operator: { permission: ["replicant-write"] },
	},
	replicant: {
		count: { schema: Schema.Number, permission: anonymousRead },
	},
	topic: {
		cheer: { schema: Schema.String, permission: anonymousReadWrite },
	},
	rpc: {
		roll: {
			schema: { request: Schema.Number, response: Schema.Number },
			permission: anonymousWrite,
		},
	},
});

export const settingsManifest = defineNamespace("settings", {
	roles: {
		operator: { permission: ["replicant-write"] },
	},
	replicant: {
		title: { schema: Schema.String, permission: anonymousRead },
	},
});
