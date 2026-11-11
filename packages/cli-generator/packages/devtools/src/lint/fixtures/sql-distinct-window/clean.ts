import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const database = drizzle("postgres://fixture")

const distinct = database.selectDistinct({ id: accounts.id }).from(accounts).as("distinct")

export const numbered = database
	.select({ id: distinct.id, rank: sql`row_number() over (order by ${distinct.id})` })
	.from(distinct)
