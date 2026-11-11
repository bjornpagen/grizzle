import { sql } from "drizzle-orm"

export const counted = sql<number>`count(*)` // violation

export const maybe = sql<number | null>`max(1)` // violation

export const decoded = sql<number>`count(*)`.mapWith(Number)

export const text = sql<string>`lower('x')`

export const untyped = sql`count(*)`
