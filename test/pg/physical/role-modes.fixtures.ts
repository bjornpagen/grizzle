/** What the property of role-modes.test.ts reads: its space, its features and the probes it sends. */

import type { Gen } from "@bjornpagen/testing/gen"
import {
	type Mutability,
	mutabilityGen,
	type RoleCase,
	roleCaseGen
} from "#test/unit/physical/insert-grants.fixtures.ts"

/** A case: two roles over the shops schema, each relation it writes under a drawn list, and each drawn relation open or
 * closed (test/unit/physical/insert-grants.fixtures.ts). */
export interface ModesCase {
	readonly clerk: RoleCase
	readonly keeper: RoleCase
	readonly mutability: Mutability
}

export const modesGen: Gen<ModesCase> = (source) => ({
	clerk: source.draw(roleCaseGen),
	keeper: source.draw(roleCaseGen),
	mutability: source.draw(mutabilityGen)
})

export type ModesFeature =
	| "an open relation under the insert list"
	| "a closed relation under the insert list"
	| "an open relation under the write list"
	| "an owner's recount columns held"
	| "an owner held for its reads alone"
	| "an UPDATE refused by PostgreSQL"
	| "a DELETE refused by PostgreSQL"

export const modesFeatures: ReadonlyArray<ModesFeature> = [
	"an open relation under the insert list",
	"a closed relation under the insert list",
	"an open relation under the write list",
	"an owner's recount columns held",
	"an owner held for its reads alone",
	"an UPDATE refused by PostgreSQL",
	"a DELETE refused by PostgreSQL"
]

/** The field each relation's UPDATE probe sets: a caller's field, never a key's, a count or an end grizzle recounts. */
export const probedField = {
	Store: "label",
	Item: "qty",
	Shelf: "tag",
	Slot: "what",
	Ticket: "note"
} as const

/**
 * The table privileges a role holds on a table as PostgreSQL's catalog answers them, a column privilege counting as its
 * table's: SELECT, INSERT and UPDATE of any column (has_any_column_privilege, which a table privilege answers too),
 * DELETE and TRUNCATE of the table, each "true" or "false", in that order.
 */
export const privilegeQuery = `SELECT pg_catalog.has_any_column_privilege($1::name, $2::regclass, 'SELECT')::text,
	pg_catalog.has_any_column_privilege($1::name, $2::regclass, 'INSERT')::text,
	pg_catalog.has_any_column_privilege($1::name, $2::regclass, 'UPDATE')::text,
	pg_catalog.has_table_privilege($1::name, $2::regclass, 'DELETE')::text,
	pg_catalog.has_table_privilege($1::name, $2::regclass, 'TRUNCATE')::text`
