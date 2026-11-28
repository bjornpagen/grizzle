/** What the property of digest-signatures.test.ts reads: its space, its declarations and what grizzle makes of them. */

import { type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { Fn } from "#compiler/public/compute.ts"
import { sha256, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyFunction, fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import type { SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { joined } from "#test/support/chunked.ts"
import { asDrafted, compilation } from "#test/support/migrate/kit.ts"
import { compiledLogin } from "#test/support/served-login.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** Where a digest stands in a declared function's signature: each a function of its own. */
export const places = [
	"a digest argument",
	"a digest result",
	"rows of a heading holding a digest",
	"a row of a heading holding a digest"
] as const
export type Place = (typeof places)[number]

/** A case: the places its schema declares a function at, one at least. */
export type DigestCase = ReadonlyArray<Place>

export const space: Gen<DigestCase> = subset(places, { min: 1, max: places.length })

const Text = str.regex("^.*$", "su")

/** A heading of a digest beside a text: a single's, as edullm's grading machine carries one. */
const Digested = rows({ digest: sha256, label: Text })

/** A digest argument: a function of a digest. */
const seedOf = fn("seedOf", {
	calls: [],
	args: { seed: sha256 },
	returns: int4,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT pg_catalog.get_byte($1, 0)`
})

/** A digest result: a text's digest, whose value a read casts to the digest domain. */
const keyedDigest = fn("keyedDigest", {
	calls: [],
	args: { text: Text },
	returns: sha256,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8'))`
})

/** Rows of a heading holding a digest. */
const singles = fn("singles", {
	calls: [],
	args: { text: Text },
	returns: Digested,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), $1`
})

/** A row of a heading holding a digest, taken and returned. */
const single = fn("single", {
	calls: [],
	args: { one: row(Digested) },
	returns: row(Digested),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT $1`
})

/** Each place's function, its body text alone, which PostgreSQL reads at install. */
const functionsAt: { readonly [P in Place]: AnyFunction } = {
	"a digest argument": seedOf,
	"a digest result": keyedDigest,
	"rows of a heading holding a digest": singles,
	"a row of a heading holding a digest": single
}

const Note = relation("Note", { id: int4, text: Text }, ["id"])

/** What grizzle makes of a case: whether it owns, and where it does, its statements and the read's served SQL. */
export type Made =
	| { readonly kind: "refused"; readonly why: string }
	| {
			readonly kind: "owned"
			readonly statements: ReadonlyArray<SqlStatement>
			readonly served: string | undefined
	  }

export const madeOf = (c: DigestCase): Effect.Effect<Made> =>
	Effect.gen(function* () {
		const declared = Arr.map(
			Arr.filter(places, (p) => Arr.contains(c, p)),
			(p) => functionsAt[p]
		)
		const reads = Arr.contains(c, "a digest result")
		const s = schema("DigestSignatures", [...declared, Note], [])
		const installation = compilation(s, asDrafted)
		if (!installation.ok) {
			return { kind: "refused", why: installation.error.reason._tag }
		}
		if (!reads) {
			return { kind: "owned", statements: installation.value.statements, served: undefined }
		}
		const keys = query(s).rule((r) => {
			const { id, text } = v(Note, "note")
			return r.match(Note, { id, text }).find({ id, digest: Fn.call(keyedDigest, { text }) })
		})
		const compiled = yield* Effect.orDie(
			compiledLogin(fullWorld(s, { keys }, []).server, (owned) => firstCodebook(rostersOf(owned)))
		)
		return {
			kind: "owned",
			statements: installation.value.statements,
			served: joined(compiled.entry.text)
		}
	})

/** Whether a type is bytea, a digest's base type, as a signature and a row type's attribute take a digest. */
export const isBytea = (t: TypeRef): boolean => t.kind === "builtin" && t.name === "bytea"

/** Each declared function's signature as installed: its name, its parameters' types and its result's type. */
export const signaturesOf = (statements: ReadonlyArray<SqlStatement>) =>
	Arr.flatMap(statements, (s) =>
		s.kind === "createDeclaredFunction"
			? [
					{
						name: s.name.name,
						params: Arr.map(s.params, (p) => [p.name, p.type] as const),
						returns: s.returns
					}
				]
			: []
	)

/** Each row type's attributes as installed, by name. */
export const rowTypesOf = (statements: ReadonlyArray<SqlStatement>) =>
	Arr.flatMap(statements, (s) =>
		s.kind === "createRowType" ? [Arr.map(s.attributes, (a) => [a.name, a.type] as const)] : []
	)
