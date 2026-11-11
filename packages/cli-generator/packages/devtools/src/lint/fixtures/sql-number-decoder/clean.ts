import { sql } from "drizzle-orm"

export const decoded = sql<number>`count(*)`.mapWith(Number)

export const raw = sql<unknown>`count(*)`
