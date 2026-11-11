import { type SQL, sql } from "drizzle-orm"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

declare const flag: SQL

const label = "x"

export const thenArm = sql`case when ${flag} then ${label} else 'none' end` // violation

export const elseArm = sql`case when ${flag} then 'yes' else ${label} end` // violation

export const typed = sql`case when ${flag} then ${sql`'yes'`} else 'no' end`

export const column = sql`case when ${flag} then ${accounts.id} end`

export const inner = sql`case when ${flag} then lower(${label}) end`
