import { HttpApiBuilder } from "@effect/platform";
import { Layer } from "effect";

import { RootApi } from "../root-api.ts";
import { InternalGroupsLive } from "./api-internal.ts";
import { PublicGroupsLive } from "./api-v0.ts";

export const RootApiLive = HttpApiBuilder.api(RootApi).pipe(
	Layer.provide(InternalGroupsLive),
	Layer.provide(PublicGroupsLive),
);
