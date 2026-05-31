import { defineState } from "@nodecg/core";
import { Schema } from "effect";

export const fixtureManifest = defineState("e2e", {
	count: { schema: Schema.Number },
	label: { schema: Schema.String },
});

export const initialValues = {
	count: () => 0,
	label: () => "hello",
};
