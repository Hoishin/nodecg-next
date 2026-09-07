import { InternalApi, PublicApi } from "@nodecg-next/internal";
import { HttpApi } from "effect/unstable/httpapi";

export const RootApi = HttpApi.make("NodeCG")
	.addHttpApi(InternalApi)
	.addHttpApi(PublicApi);
