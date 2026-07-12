import { HttpApi } from "@effect/platform";

import { MachineAuthenticationMiddleware } from "../auth.ts";
import { fieldGroup } from "./shared.ts";

export const PublicApi = HttpApi.make("PublicApi")
	.add(fieldGroup("PublicField").middleware(MachineAuthenticationMiddleware))
	.prefix("/api/v0");
