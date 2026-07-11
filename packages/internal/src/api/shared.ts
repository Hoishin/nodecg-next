import {
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
} from "@effect/platform";
import { Schema } from "effect";

import { JsonValueSchema } from "../utils/json-value-schema.ts";

const namespaceParam = HttpApiSchema.param("namespace", Schema.String);
const fieldNameParam = HttpApiSchema.param("fieldName", Schema.String);

const replicantGet = HttpApiEndpoint.get(
	"replicantGet",
)`/namespaces/${namespaceParam}/replicant/${fieldNameParam}`
	.addSuccess(JsonValueSchema)
	.addError(HttpApiError.NotFound)
	.addError(HttpApiError.Forbidden)
	.addError(HttpApiError.InternalServerError);

const replicantUpdate = HttpApiEndpoint.put(
	"replicantUpdate",
)`/namespaces/${namespaceParam}/replicant/${fieldNameParam}`
	.setPayload(JsonValueSchema)
	.addError(HttpApiError.NotFound)
	.addError(HttpApiError.Forbidden)
	.addError(HttpApiError.BadRequest)
	.addError(HttpApiError.InternalServerError);

const computedGet = HttpApiEndpoint.get(
	"computedGet",
)`/namespaces/${namespaceParam}/computed/${fieldNameParam}`
	.addSuccess(JsonValueSchema)
	.addError(HttpApiError.NotFound)
	.addError(HttpApiError.Forbidden)
	.addError(HttpApiError.InternalServerError);

const topicPublish = HttpApiEndpoint.post(
	"topicPublish",
)`/namespaces/${namespaceParam}/topic/${fieldNameParam}`
	.setPayload(JsonValueSchema)
	.addError(HttpApiError.NotFound)
	.addError(HttpApiError.Forbidden)
	.addError(HttpApiError.BadRequest);

export class RpcCallError extends Schema.TaggedError<RpcCallError>()(
	"RpcCallError",
	{ message: Schema.String },
	HttpApiSchema.annotations({ status: 500 }),
) {}

const rpcCall = HttpApiEndpoint.post(
	"rpcCall",
)`/namespaces/${namespaceParam}/rpc/${fieldNameParam}`
	.setPayload(JsonValueSchema)
	.addSuccess(JsonValueSchema)
	.addError(HttpApiError.NotFound)
	.addError(HttpApiError.Forbidden)
	.addError(HttpApiError.BadRequest)
	.addError(RpcCallError);

export const fieldGroup = <const Id extends string>(id: Id) =>
	HttpApiGroup.make(id)
		.add(replicantGet)
		.add(replicantUpdate)
		.add(computedGet)
		.add(topicPublish)
		.add(rpcCall);
