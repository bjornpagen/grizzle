/** What the property of literal-opposite.test.ts reads: each place a bare literal meets a column, and its compile. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { float4, int4, numeric } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import {
	codebookFor,
	compileTemplate,
	type FixtureSchema,
	firstCodes,
	schemaInputOf,
	testCompile
} from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"

/**
 * Where a bare literal meets a numeric(5, 1) column: a select() side's selection, as a containment reads it; a rule's
 * match binding, as a containment into the rule reads it, over a relation keyed by the column's id alone or by id and
 * the column, which a rule fixing the column lowers to a foreign key; a read's match binding, a negated match's binding,
 * and a read's predicate by `eq`, `between` and `in`. And where one meets a real column, the other type that rounds a
 * value into itself: a read's match binding and its `eq`.
 */
export const places = [
	"a selection a containment reads",
	"a match binding a containment reads, keyed by id",
	"a match binding a containment reads, keyed by id and x",
	"a read's match binding",
	"a read's negated match binding",
	"a read's eq",
	"a read's between",
	"a read's in",
	"a real's match binding",
	"a real's eq"
] as const
export type Place = (typeof places)[number]

/**
 * The literals: one its column's type holds as written, and one of more digits than it holds, which PostgreSQL's
 * coercion would round into the type and a comparison reads exactly.
 */
export const literals = ["as written", "more digits"] as const
export type LiteralForm = (typeof literals)[number]

/** Each literal opposite numeric(5, 1): 1.3, and 1.25, which its coercion rounds to 1.3. */
const decimals = { "as written": "1.3", "more digits": "1.25" } as const

/** Each literal opposite real: 0.5, a binary32 value, and 0.1, which its coercion rounds to binary32's nearest. */
const reals = { "as written": 0.5, "more digits": 0.1 } as const

/** The refusal's words for a case's literal: the literal as written and the type it is compared at. */
const refusedFor = (c: Placed): string =>
	c.place === "a real's match binding" || c.place === "a real's eq"
		? `${reals[c.literal]} has more digits than real holds`
		: `${decimals[c.literal]} has more digits than numeric(5,1) holds`

/** One case: a place and a literal. */
export interface Placed {
	readonly place: Place
	readonly literal: LiteralForm
}

const B = relation("B", { id: int4, x: numeric(5, 1) }, ["id"])

/** B keyed by id and x, so a rule fixing x is keyed within B and lowers to a foreign key. */
const BKeyed = relation("BKeyed", { id: int4, x: numeric(5, 1) }, ["id", "x"])

const A = relation("A", { id: int4 }, ["id"])

const N = relation("N", { x: numeric(5, 1) }, ["x"])

const R = relation("R", { id: int4, y: float4 }, ["id"])

const Base = schema("LiteralOpposite", [B, BKeyed, A, N, R], [])

/** A containment into a rule binding x of B, keyed by id alone or by id and x, to `value`, which its law reads. */
const ruleBound = (keyed: boolean, value: (typeof decimals)[LiteralForm]): FixtureSchema => {
	const At = derived(
		"At",
		keyed
			? query(Base).rule((r) => {
					const { id } = v(BKeyed, "b")
					return r.match(BKeyed, { id, x: value }).find({ id })
				})
			: query(Base).rule((r) => {
					const { id } = v(B, "b")
					return r.match(B, { id, x: value }).find({ id })
				})
	)
	return schema.extend([Base], "LiteralOppositeRule", [At], [contained(on(A, "id"), on(At, "id"))])
}

/** The schema of a place a containment reads, or the read of a place a query reads. */
const compiled = (c: Placed): Result.Result<unknown, CompileError> => {
	const installed = (s: FixtureSchema) =>
		Result.flatMap(codebookFor(schemaInputOf(s), firstCodes), (codes) =>
			planRealInstall(s, {
				installation: identity.schema(parsedSchemaName("LiteralOpposite")),
				extensions: [],
				codes,
				compile: compileInstallation
			})
		)
	const read = (q: unknown) => compileTemplate(q, Base, testCompile)
	switch (c.place) {
		case "a selection a containment reads":
			return installed(
				schema(
					"LiteralOpposite",
					[B, A],
					[
						contained(
							on(A, "id"),
							on(
								select(B, (b) => b.eq(b.x, decimals[c.literal])),
								"id"
							)
						)
					]
				)
			)
		case "a match binding a containment reads, keyed by id":
			return installed(ruleBound(false, decimals[c.literal]))
		case "a match binding a containment reads, keyed by id and x":
			return installed(ruleBound(true, decimals[c.literal]))
		case "a read's match binding":
			return read(
				query(Base).rule((r) => {
					const { id } = v(B, "b")
					return r.match(B, { id, x: decimals[c.literal] }).find({ id })
				})
			)
		case "a read's negated match binding":
			return read(
				query(Base).rule((r) => {
					const { id } = v(A, "a")
					return r
						.match(A, { id })
						.where(r.not(N, { x: decimals[c.literal] }))
						.find({ id })
				})
			)
		case "a read's eq":
			return read(
				query(Base).rule((r) => {
					const { id, x } = v(B, "b")
					return r.match(B, { id, x }).where(r.eq(x, decimals[c.literal])).find({ id })
				})
			)
		case "a read's between":
			return read(
				query(Base).rule((r) => {
					const { id, x } = v(B, "b")
					return r
						.match(B, { id, x })
						.where(r.between(x, decimals[c.literal], "2.0"))
						.find({ id })
				})
			)
		case "a real's match binding":
			return read(
				query(Base).rule((r) => {
					const { id } = v(R, "r")
					return r.match(R, { id, y: reals[c.literal] }).find({ id })
				})
			)
		case "a real's eq":
			return read(
				query(Base).rule((r) => {
					const { id, y } = v(R, "r")
					return r.match(R, { id, y }).where(r.eq(y, reals[c.literal])).find({ id })
				})
			)
		case "a read's in":
			return read(
				query(Base).rule((r) => {
					const { id, x } = v(B, "b")
					return r
						.match(B, { id, x })
						.where(r.in(x, [decimals[c.literal]]))
						.find({ id })
				})
			)
	}
}

/**
 * The compile of a case: compiled, or refused for its literal, MalformedDescription naming the literal and the type it
 * is compared at, whether the compile returns the refusal or a builder throws it as it types the predicate; any other
 * refusal is its own message.
 */
export type Verdict =
	| { readonly kind: "compiled" }
	| { readonly kind: "refused for its digits" }
	| { readonly kind: "refused otherwise"; readonly message: string }

const verdictOfError = (c: Placed, error: CompileError): Verdict =>
	error.reason._tag === "MalformedDescription" && Str.includes(refusedFor(c))(error.message)
		? { kind: "refused for its digits" }
		: { kind: "refused otherwise", message: error.message }

export const verdictOf = (c: Placed): Verdict => {
	const result = Result.flatMap(
		catchCompileError(() => compiled(c)),
		(r) => r
	)
	return result.ok ? { kind: "compiled" } : verdictOfError(c, result.error)
}
