import type { SQL } from "drizzle-orm"
import type { Effect } from "effect"

export type Render = (statement: SQL) => string

export interface Loader {
	load(id: number): Effect.Effect<unknown>
}
