import { sql } from "drizzle-orm"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const tagged = (strings: TemplateStringsArray): string => strings.join("")

export const lowered = sql`lower(${accounts.id})` // violation

export const nested = sql`coalesce(${sql`1`}, 0)` // violation

export const other = tagged`lower(x)`

export const named = sql.identifier("accounts")
