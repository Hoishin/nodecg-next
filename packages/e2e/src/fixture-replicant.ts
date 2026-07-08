import { defineNamespace, extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

const anonymousRead = { read: { allow: ["anonymous"] } } as const;
const anonymousReadWrite = {
	read: { allow: ["anonymous"] },
	write: { allow: ["anonymous"] },
} as const;
const anonymousWrite = { write: { allow: ["anonymous"] } } as const;

export const fixtureManifest = defineNamespace("e2e", {
	roles: {
		producer: { permission: ["replicant-write"] },
		viewer: { permission: [] },
	},
	replicant: {
		count: { schema: Schema.Number, permission: anonymousRead },
		label: { schema: Schema.String, permission: anonymousRead },
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
		doubledCount: { schema: Schema.Number, permission: anonymousRead },
		summary: { schema: Schema.String, permission: anonymousRead },
	},
	topic: {
		chat: { schema: Schema.String, permission: anonymousReadWrite },
	},
	rpc: {
		echo: {
			schema: { request: Schema.String, response: Schema.String },
			permission: anonymousWrite,
		},
		bump: {
			schema: { request: Schema.Number, response: Schema.Number },
			permission: anonymousWrite,
		},
	},
});

export const baseManifest = defineNamespace("e2e-extend", {
	roles: {
		producer: { permission: ["replicant-write"] },
	},
	replicant: {
		score: { schema: Schema.Number, permission: anonymousRead },
	},
});

export const extendedManifest = extendNamespace(baseManifest, {
	replicant: {
		bonus: { schema: Schema.Number, permission: anonymousRead },
	},
	computed: {
		total: { schema: Schema.Number, permission: anonymousRead },
	},
});
