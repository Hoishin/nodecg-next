import { defineState } from "@nodecg/core";
import { Schema } from "effect";

export const counterState = defineState("counter", {
	count: { schema: Schema.Number },
});
