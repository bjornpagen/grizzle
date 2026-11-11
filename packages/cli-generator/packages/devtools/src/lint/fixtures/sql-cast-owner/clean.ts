import { sql } from "drizzle-orm"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

export const cast = sql`${accounts.id}::text`
