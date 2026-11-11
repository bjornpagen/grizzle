import { type SQL, sql } from "drizzle-orm"

declare const flag: SQL

export const typed = sql`case when ${flag} then ${sql`'yes'`} else ${sql`'no'`} end`
