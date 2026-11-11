import { sql } from "drizzle-orm"
import { jsonb, pgTable } from "drizzle-orm/pg-core"

const documents = pgTable("documents", { body: jsonb().notNull() })

export const field = sql`${documents.body} ->> 'name'`

export const kind = sql`jsonb_typeof(${documents.body})`
