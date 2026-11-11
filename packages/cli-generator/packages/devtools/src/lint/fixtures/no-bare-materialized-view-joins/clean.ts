import { eq, getViewName } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgMaterializedView, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const totals = pgMaterializedView("totals", { id: integer().notNull() }).existing()

const database = drizzle("postgres://fixture")

const relation = database.select({ id: totals.id }).from(totals).as(getViewName(totals))

export const joined = database
	.select({ id: accounts.id })
	.from(accounts)
	.innerJoin(relation, eq(accounts.id, relation.id))
