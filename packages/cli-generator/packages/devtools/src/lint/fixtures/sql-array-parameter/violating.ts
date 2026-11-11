import { sql } from "drizzle-orm"

const ids: ReadonlyArray<string> = ["a"]

const pair: readonly [number, number] = [1, 2]

export const listed = sql`id = any(${ids}::uuid[])` // violation

export const tupled = sql`${pair}::int[]` // violation

export const bound = sql`id = any(${sql.param(ids)}::uuid[])`

export const scalar = sql`${"a"}::uuid`

export const spaced = sql`${ids} :: uuid[]`
