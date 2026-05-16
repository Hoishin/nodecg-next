import { Context } from "effect";

import type { StateStorage } from "./state-storage";

export class StateStorageService extends Context.Tag("StateStorage")<
	StateStorageService,
	StateStorage
>() {}
