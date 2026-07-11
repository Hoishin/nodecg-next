import { HttpApi } from "@effect/platform";
import { InternalApi, PublicApi } from "@nodecg/internal";

export const RootApi = HttpApi.make("NodeCG")
	.addHttpApi(InternalApi)
	.addHttpApi(PublicApi);
