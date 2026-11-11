import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgMaterializedView, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const ledger = pgTable("ledger", { account: integer().notNull() })

const totals = pgMaterializedView("totals", { id: integer().notNull() }).existing()

const database = drizzle("postgres://fixture")

const subquery = database.select({ id: totals.id }).from(totals).as("totals")

const selection = database.select({ id: accounts.id }).from(accounts)

export const inner = selection.innerJoin(totals, eq(accounts.id, totals.id)) // violation

export const left = selection.leftJoin(totals, eq(accounts.id, totals.id)) // violation

export const wrapped = selection.innerJoin(subquery, eq(accounts.id, subquery.id))

export const table = selection.innerJoin(ledger, eq(accounts.id, ledger.account))
