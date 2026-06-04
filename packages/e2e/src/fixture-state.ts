import { defineState } from "@nodecg/core";
import { Schema } from "effect";

export const fixtureManifest = defineState(
	"e2e",
	{
		count: { schema: Schema.Number },
		label: { schema: Schema.String },
	},
	{
		computed: {
			doubledCount: { schema: Schema.Number },
			summary: { schema: Schema.String },
		},
	},
);

export const initialValues = {
	count: () => 0,
	label: () => "hello",
};

export const computed = {
	doubledCount: (sources: { count: number }) => sources.count * 2,
	summary: (sources: { count: number; label: string }) =>
		sources.count > 0 ? `${sources.label} x${sources.count}` : "idle",
};
