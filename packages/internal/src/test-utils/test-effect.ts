import { Layer } from "effect";

import { makeTestEffect } from "./make-test-effect.ts";

export const testEffect = makeTestEffect(Layer.empty);
