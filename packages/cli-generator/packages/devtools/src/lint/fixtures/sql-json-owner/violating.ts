import { sql } from "drizzle-orm"
import { jsonb, pgTable } from "drizzle-orm/pg-core"

const documents = pgTable("documents", { body: jsonb().notNull() })

export const field = sql`${documents.body} ->> 'name'` // violation

export const path = sql`${documents.body} #> '{a,b}'` // violation

export const kind = sql`jsonb_typeof(${documents.body})` // violation

export const elements = sql`jsonb_array_elements_text(${documents.body})` // violation

export const quoted = sql`'->'`

export const difference = sql`${documents.body} - 'name'`

export const longer = sql`jsonb_typeofs(${documents.body})`
