import { sql } from "drizzle-orm"
import { alias, integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const parent = alias(accounts, "parent")

const copied = parent

const tables = { parent }

export const direct = sql`exists (${parent})` // violation

export const throughCopy = sql`${copied}` // violation

export const throughProperty = sql`${tables.parent}` // violation

export const declared = sql`${accounts} as ${parent}`

export const column = sql`${parent.id}`

export const base = sql`${accounts}`
