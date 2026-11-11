import { Pool } from "pg"

const PRINCIPALS = { reader: "reader", writer: "writer" } as const

const READER_TIMEOUT_MILLISECONDS = 30_000

declare const username: string

export const pool = new Pool({
	statement_timeout: 1000, // violation
	idleTimeoutMillis: 1000
})

export type Limits = Readonly<{ queryTimeoutMs: number }> // violation

export const refused = "budget-exhausted" // violation

export const guarded = new Pool({
	statement_timeout: username === PRINCIPALS.reader ? READER_TIMEOUT_MILLISECONDS : false // violation
})

export const budget = { remaining: 3 }
