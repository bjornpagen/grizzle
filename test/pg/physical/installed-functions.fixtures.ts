/** What installed-functions.test.ts draws: schemas whose installation creates a function of each kind the installer
 * names a constant by (physical/ddl/context.ts addConstant). */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Crypto } from "#compiler/public/compute.ts"
import { key, login, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { Id } from "#test/support/ids.ts"
import {
	type RowCase,
	rowCaseGen,
	rowSchemaOf
} from "#test/unit/physical/row-functions.fixtures.ts"

/**
 * A case: one of the row-function boxes (row-functions.fixtures.ts), a relation contained in a closed relation over a
 * roster or one matching patterns, whose installation creates a closed relation's constants, a roster's constants and
 * row functions; or a relation of a text calling the library's digest in a generated field, or keyed by a text of no
 * byte bound, which the key holds by its image, the library's digest too, with a login of a role that writes the
 * relation and one that reads it.
 */
export type FunctionCase =
	| { readonly kind: "rows"; readonly row: RowCase }
	| { readonly kind: "library"; readonly use: LibraryUse }

/**
 * The library functions a box calls: Crypto.sha256's and a key's image, both the library's text digest. Text.resolveReference
 * and Xml.isPattern install bodies whose derived tables and CTEs carry hand-named aliases (physical/ddl/library.ts), which
 * the structural audit every migrated install runs refuses (test/support/oracle/verify/sql.ts naming), so a box over
 * them dies at that audit before the catalog checker reads it: they join this list where their bodies take their
 * aliases from the name supply.
 */
const libraryUses = [
	"Crypto.sha256 in a generated field",
	"a key over a text of no byte bound"
] as const

export type LibraryUse = (typeof libraryUses)[number]

export const functionCaseGen: Gen<FunctionCase> = (s) =>
	s.draw(element([true, false] as const))
		? { kind: "rows", row: s.draw(rowCaseGen) }
		: { kind: "library", use: s.draw(element(libraryUses)) }

const text = str.regex("^.*$", "su")

/** A library case's schema, its relation R calling the library at `use`, with the login of R's writer and reader. */
const librarySchemaOf = (use: LibraryUse) => {
	const fields = { id: Id, body: text }
	const R =
		use === "Crypto.sha256 in a generated field"
			? relation.generated("R", fields, ["id"], (r) => ({
					digest: generatedField(text, Crypto.sha256(r.body), [])
				}))
			: relation("R", fields, ["id"])
	const statements = use === "a key over a text of no byte bound" ? [key(on(R, "body"))] : []
	const s = schema("Library", [R], statements)
	return {
		schema: s,
		login: login(s, "desk", [
			role(s, "writer", { R }, { write: ["R"], refresh: [] }),
			role(s, "reader", { R }, { write: [], refresh: [] })
		])
	}
}

/** A case's schema and the logins it installs with: a row box's none, a library case's its desk. */
export const functionSchemaOf = (c: FunctionCase) => {
	switch (c.kind) {
		case "rows":
			return { schema: rowSchemaOf(c.row), logins: [] }
		case "library": {
			const built = librarySchemaOf(c.use)
			return { schema: built.schema, logins: [built.login] }
		}
	}
}
