/** What the property of absent-claims.test.ts reads: its schema, role and login, its template and its settings. */
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { migratedOnceTemplate } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A role's query entry that reads a context, read by hand, as a direct reader reads it: Seat holds seats by their
 * holder's subject, and the role `holder` reads MySeat, the seats of the session's subject (the Session context), as a
 * view whose rows read the claims setting through the entry's context source (sql/print.ts contextClaims). Its one
 * stored seat is ann's.
 */
const Subject = str.regex("^u_[a-z]{1,8}$")

const Seat = relation("Seat", { id: int4, holder: Subject }, ["id"])

export const seatsAt = (name: string) => {
	const base = schema(name, [Seat], [])
	const Session = context("Session", { sub: Subject })
	const mine = query(base).rule((r) => {
		const { id, holder } = v(Seat, "seat")
		return r.match(Seat, { id, holder }).match(Session, { sub: holder }).find({ id })
	})
	const holder = role(base, "holder", { MySeat: mine }, { contexts: [Session] })
	return { base, holder, desk: login(base, "desk", [holder]) }
}

export const claimsTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "absent claims",
	options: {
		label: "claims",
		first: (name) => {
			const seats = seatsAt(name)
			return { schema: seats.base, logins: [seats.desk] }
		},
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})

/**
 * How the claims setting stands as the reader reads MySeat: never set in its session; set to the empty text; set for
 * an earlier transaction, which its end emptied; a claims document of no fact; a document naming ann's subject.
 */
export const settings = [
	"never set",
	"set to the empty text",
	"emptied by its transaction's end",
	"a document of no fact",
	"a document naming ann"
] as const

export type Setting = (typeof settings)[number]

/** What a read of MySeat meets under a setting: its rows' count, or the absent claims' refusal. */
export type Outcome =
	| { readonly kind: "rows"; readonly count: number }
	| { readonly kind: "absent" }

/**
 * The model: a setting that holds no claims document, never set or empty, is refused as absent (22P02, the constraint
 * `grizzle.claims`, the DETAIL `c-`), never read as a document of no fact; a document reads the seats of the subject it
 * names, none where it names none.
 */
export const outcomeOf = (setting: Setting): Outcome => {
	switch (setting) {
		case "never set":
		case "set to the empty text":
		case "emptied by its transaction's end":
			return { kind: "absent" }
		case "a document of no fact":
			return { kind: "rows", count: 0 }
		case "a document naming ann":
			return { kind: "rows", count: 1 }
	}
}
