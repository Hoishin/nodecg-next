import { defineNamespace, extendNamespace } from "@nodecg/core";
import { Schema } from "effect";

const everyoneRead = { read: { allow: ["everyone"] } } as const;
const everyoneReadWrite = {
	read: { allow: ["everyone"] },
	write: { allow: ["everyone"] },
} as const;
const everyoneWrite = { write: { allow: ["everyone"] } } as const;

export const fixtureManifest = defineNamespace("e2e", {
	roles: {
		producer: { permission: ["replicant-write"] },
		viewer: { permission: [] },
	},
	replicant: {
		count: { schema: Schema.Number, permission: everyoneRead },
		label: { schema: Schema.String, permission: everyoneRead },
		secret: { schema: Schema.String, permission: { write: { allow: [] } } },
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
		doubledCount: { schema: Schema.Number, permission: everyoneRead },
		summary: { schema: Schema.String, permission: everyoneRead },
	},
	topic: {
		chat: { schema: Schema.String, permission: everyoneReadWrite },
	},
	rpc: {
		echo: {
			schema: { request: Schema.String, response: Schema.String },
			permission: everyoneWrite,
		},
		bump: {
			schema: { request: Schema.Number, response: Schema.Number },
			permission: everyoneWrite,
		},
	},
});

export const baseManifest = defineNamespace("e2e-extend", {
	roles: {
		producer: { permission: ["replicant-write"] },
	},
	replicant: {
		score: { schema: Schema.Number, permission: everyoneRead },
	},
});

export const extendedManifest = extendNamespace(baseManifest, {
	replicant: {
		bonus: { schema: Schema.Number, permission: everyoneRead },
	},
	computed: {
		total: { schema: Schema.Number, permission: everyoneRead },
	},
});

export const crossManifest = defineNamespace("e2e-cross", {
	replicant: {
		factor: { schema: Schema.Number, permission: everyoneRead },
	},
	computed: {
		scaledScore: { schema: Schema.Number, permission: everyoneRead },
	},
	rpc: {
		addScore: {
			schema: { request: Schema.Number, response: Schema.Number },
			permission: everyoneWrite,
		},
	},
});
