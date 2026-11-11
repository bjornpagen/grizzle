import { sql } from "drizzle-orm"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

export const cast = sql`${accounts.id}::text` // violation

export const arrayCast = sql`array[]::int[]` // violation

export const quoted = sql`'a::b'`

export const commented = sql`1 -- ::text`

export const plain = sql`lower(${accounts.id})`
