import { sql } from "drizzle-orm"

const ids: ReadonlyArray<string> = ["a"]

export const bound = sql`id = any(${sql.param(ids)}::uuid[])`
