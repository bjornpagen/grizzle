import { Pool } from "pg"

const PRINCIPALS = { reader: "reader", writer: "writer" } as const

export const READER_TIMEOUT_MILLISECONDS = 30_000

declare const username: string

export const pool = new Pool({
	statement_timeout: username === PRINCIPALS.reader ? READER_TIMEOUT_MILLISECONDS : false,
	idleTimeoutMillis: 1000
})
