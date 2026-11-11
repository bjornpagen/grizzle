import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const database = drizzle("postgres://fixture")

export const numbered = database
	.selectDistinct({
		id: accounts.id,
		rank: sql`row_number() over (order by ${accounts.id})` // violation
	})
	.from(accounts)

export const numberedOn = database
	.selectDistinctOn([accounts.id], {
		rank: sql`rank() OVER(order by 1)` // violation
	})
	.from(accounts)

export const plain = database
	.select({ rank: sql`row_number() over (order by 1)` })
	.from(accounts)

export const counted = database
	.selectDistinct({ id: accounts.id, total: sql`count(*)` })
	.from(accounts)

export const quoted = database.selectDistinct({ label: sql`'over ('` }).from(accounts)

export const longer = database.selectDistinct({ label: sql`hangover(1)` }).from(accounts)
