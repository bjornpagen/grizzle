import type { SQL } from "drizzle-orm"
import type { Effect } from "effect"

export type Run = (statement: SQL) => Promise<unknown> // violation

export interface Executor {
	run(statement: SQL): Effect.Effect<unknown> // violation
}

export type Render = (statement: SQL) => string

export type Fetch = (url: string) => Promise<unknown>

export interface Holder {
	execute: (input: number) => Promise<void>
}
