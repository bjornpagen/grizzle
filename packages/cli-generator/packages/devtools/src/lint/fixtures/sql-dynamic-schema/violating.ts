import { integer, pgSchema, pgTable, text } from "drizzle-orm/pg-core"

const columns = { id: integer().notNull() }

const key = "name"

const schemaName = "dynamic"

const app = pgSchema("app")

export const spread = pgTable("spread", { ...columns, name: text() }) // violation

export const shared = pgTable("shared", columns) // violation

export const computed = pgTable("computed", { [key]: text() }) // violation

export const factory = (name: string) => pgTable(name, { id: integer() }) // violation

export const stageOf = (name: string) => pgTable(name, { id: integer() }) // violation

export const inSchema = app.table("in_schema", { ...columns }) // violation

export const dynamic = pgSchema(schemaName) // violation

export const late = () => pgSchema("late") // violation

export const literal = pgSchema(`literal`)

export const fixed = pgTable("fixed", { id: integer().notNull() })

export const fixedInSchema = app.table("fixed", { id: integer().notNull() })
