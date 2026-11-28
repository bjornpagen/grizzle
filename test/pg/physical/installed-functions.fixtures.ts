/** What installed-functions.test.ts draws: schemas whose installation creates a function of each kind the installer
 * names a constant by (physical/ddl/context.ts addConstant). */

import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Crypto, Logic, Text, Xml } from "#compiler/public/compute.ts"
import { Bit, bit, closedId, sha256, int4 } from "#compiler/public/fields.ts"
import { check, closed, key, login, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { Id } from "#test/support/ids.ts"
import { type Version } from "#test/support/install-migrate.ts"
import { renamed } from "#test/support/installed.ts"
import {
	type RowCase,
	rowCaseGen,
	rowSchemaOf
} from "#test/support/unit/physical/row-functions.fixtures.ts"

/**
 * A case: one of the row-function boxes (row-functions.fixtures.ts), a relation contained in a closed relation over a
 * roster or one matching patterns, whose installation creates a closed relation's constants, a roster's constants and
 * row functions; a relation of texts calling one of grizzle's library functions, each a generated field or a CHECK,
 * or keyed by the explicit digest of a text of no byte bound, a generated Crypto.sha256 its key holds (README's key
 * rule refuses a key over the text itself, never holding it by a digest of its own), with a login of a role
 * that writes the relation and one that reads it; or a relation whose generated set field reads no column, the
 * singleton of a closed relation's closed id at the handle `at`, the relation holding a row at each handle of `held`:
 * at a handle it holds no row of, the field is the call of a row function of no parameter, which
 * PostgreSQL evaluates as it creates the table, the drift check's replay included, and its result's bits domain's
 * CHECK reads the roster's live constant.
 */
export type FunctionCase =
	| { readonly kind: "rows"; readonly row: RowCase }
	| { readonly kind: "library"; readonly use: LibraryUse }
	| { readonly kind: "unread"; readonly held: ReadonlyArray<Handle>; readonly at: Handle }

/** The library functions a box calls: each of the library's, in a generated field, a CHECK or a key's field. */
const libraryUses = [
	"Text.resolveReference in a generated field",
	"Crypto.sha256 in a generated field",
	"Xml.isPattern in a CHECK",
	"a key over a generated Crypto.sha256 of a text of no byte bound"
] as const

export type LibraryUse = (typeof libraryUses)[number]

const handles = ["h0", "h1", "h2"] as const

type Handle = (typeof handles)[number]

export const functionCaseGen: Gen<FunctionCase> = (s) => {
	switch (s.draw(element(["rows", "library", "unread"] as const))) {
		case "rows":
			return { kind: "rows", row: s.draw(rowCaseGen) }
		case "library":
			return { kind: "library", use: s.draw(element(libraryUses)) }
		case "unread":
			return {
				kind: "unread",
				held: s.draw(subset(handles, { min: 0, max: handles.length })),
				at: s.draw(element(handles))
			}
	}
}

const text = str.regex("^.*$", "su")

/** A library case's schema, its relation R calling the library at `use`, with the login of R's writer and reader. */
const librarySchemaOf = (use: LibraryUse, name: string) => {
	const fields = { id: Id, base: text, href: text, body: text, p: text }
	const digested = relation.generated("R", fields, ["id"], (r) => ({
		digest: generatedField(sha256, Crypto.sha256(r.body), [])
	}))
	const R =
		use === "Text.resolveReference in a generated field"
			? relation.generated("R", fields, ["id"], (r) => ({
					target: generatedField(text, Text.resolveReference(r.base, r.href), [])
				}))
			: use === "Crypto.sha256 in a generated field" ||
				  use === "a key over a generated Crypto.sha256 of a text of no byte bound"
				? digested
				: relation("R", fields, ["id"])
	const statements =
		use === "Xml.isPattern in a CHECK"
			? [check("Patterned", R, (r) => Logic.eq(Xml.isPattern(r.p), true))]
			: use === "a key over a generated Crypto.sha256 of a text of no byte bound"
				? [key(on(digested, "digest"))]
				: []
	const s = schema(name, [R], statements)
	return {
		schema: s,
		login: login(s, "desk", [
			role(s, "writer", { R }, { insert: ["R"], write: [] }),
			role(s, "reader", { R }, { insert: [], write: [] })
		])
	}
}

const H = closed.ordered("H", handles)

/** An unread case's schema: Picks holds (h, h) at each handle h of `held`, and T's generated set field g is the
 * singleton of Picks' f at the handle `at`, reading no column of T. */
const unreadSchemaOf = (held: ReadonlyArray<Handle>, at: Handle) => {
	const Picks = closed.relation(
		"Picks",
		{ k: closedId(H), f: closedId(H) },
		["k"],
		Arr.map(held, (h) => ({ k: h, f: h }))
	)
	const T = relation.generated("T", { id: int4 }, ["id"], () => ({
		g: generatedField(bit(H), Bit.singleton(Picks.at("f", at)), [])
	}))
	return schema("Unread", [H, Picks, T], [])
}

/** A case's schema and the logins it installs with: a row box's none, a library case's its desk, an unread case's
 * none. */
export const functionSchemaOf = (c: FunctionCase, name: string): Version => {
	switch (c.kind) {
		case "rows":
			return { schema: renamed(rowSchemaOf(c.row), name), logins: [] }
		case "library": {
			const built = librarySchemaOf(c.use, name)
			return { schema: built.schema, logins: [built.login] }
		}
		case "unread":
			return { schema: renamed(unreadSchemaOf(c.held, c.at), name), logins: [] }
	}
}
