import { FetchHttpClient } from "@effect/platform";
import { ManagedRuntime } from "effect";

export const runtime = ManagedRuntime.make(FetchHttpClient.layer);
