import { defineNamespace, extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

const publicRead = { read: { allow: ["public"] } } as const;
const publicReadWrite = {
	read: { allow: ["public"] },
	write: { allow: ["public"] },
} as const;
const publicWrite = { write: { allow: ["public"] } } as const;

export const fixtureManifest = defineNamespace("e2e", {
	roles: {
		producer: { permission: ["state-write"] },
		viewer: { permission: [] },
	},
	state: {
		count: { schema: Schema.Number, permission: publicRead },
		label: { schema: Schema.String, permission: publicRead },
		secret: { schema: Schema.String },
		producerOnly: {
			schema: Schema.String,
			permission: { read: { allow: ["producer"] } },
		},
		membersOnly: {
			schema: Schema.String,
			permission: { read: { allow: ["client"] } },
		},
	},
	computed: {
		doubledCount: { schema: Schema.Number, permission: publicRead },
		summary: { schema: Schema.String, permission: publicRead },
	},
	topic: {
		chat: { schema: Schema.String, permission: publicReadWrite },
	},
	rpc: {
		echo: {
			schema: { request: Schema.String, response: Schema.String },
			permission: publicWrite,
		},
	},
});

export const baseManifest = defineNamespace("e2e-extend", {
	roles: {
		producer: { permission: ["state-write"] },
	},
	state: {
		score: { schema: Schema.Number, permission: publicRead },
	},
});

export const extendedManifest = extendNamespace(baseManifest, {
	state: {
		bonus: { schema: Schema.Number, permission: publicRead },
	},
	computed: {
		total: { schema: Schema.Number, permission: publicRead },
	},
});
