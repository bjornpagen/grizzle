/**
 * The SQL of a text refinement's check (text/refinement.ts analyzeText chooses it): the membership predicate over a
 * domain's VALUE, and the compiler-owned domain a nontrivial refinement is installed as. The analysis states the bytes
 * this predicate prints in as data of its own (text/refinement.ts checkSpelling), so it loads none of this module.
 */

import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { PatternCheck, RegexCheck } from "#compiler/ir/scalar.ts"
import type { Collation, Expr, TypeRef } from "#compiler/sql/ast.ts"
import { and, binary, call, cUtf8Collation, isIn, le, lit, types } from "#compiler/sql/build.ts"

/** A domain CHECK's VALUE. */
export const domainValue: Expr = Object.freeze({ kind: "domainValue" })

/** A member of `VALUE IN (...)`: the text literal its list holds. */
const memberLiteral = (member: string): Expr => lit.text(member, types.text)

/**
 * The terms of a language's membership predicate over `value`, which AND joins: `value IN (...)` of its members, or
 * `value ~ '<ARE>'` of each ARE of its conjunction.
 */
const patternTerms = (check: PatternCheck, value: Expr): NonEmptyReadonlyArray<Expr> => {
	switch (check.kind) {
		case "finite":
			return [isIn(value, mapNonEmpty(check.members, memberLiteral))]
		case "regex":
			return mapNonEmpty(check.ares, (are) => binary("~", value, lit.text(are, types.text)))
	}
}

/** A byte bound's test over `value`: `octet_length(value) <= octets`. */
const octetsTest = (octets: number, value: Expr): Expr =>
	le(call("octet_length", [value]), lit.int(octets, types.integer))

/**
 * The terms of the membership predicate over `value` (domainValue inside a domain CHECK), which AND joins, a contract's
 * among its predicate's: a language's (patternTerms), or a byte bound's test before them, so PostgreSQL's regex engine
 * never reads a value past the bound.
 */
export const membershipTerms = (check: RegexCheck, value: Expr): NonEmptyReadonlyArray<Expr> => {
	switch (check.kind) {
		case "finite":
		case "regex":
			return patternTerms(check, value)
		case "octets":
			return check.check === undefined
				? [octetsTest(check.octets, value)]
				: [octetsTest(check.octets, value), ...patternTerms(check.check, value)]
	}
}

/**
 * The membership predicate over `value` (domainValue inside a domain CHECK), without the wrapper the printer adds to
 * every CHECK: its terms (membershipTerms) joined by AND, one term alone.
 */
export const membership = (check: RegexCheck, value: Expr): Expr =>
	and(membershipTerms(check, value))

/**
 * The definition of the compiler-owned structural domain of a nontrivial refinement (physical/ddl/domains.ts
 * DomainDefinition), created as `CREATE DOMAIN <schema>.__text_<slug> AS text COLLATE pg_catalog.pg_c_utf8 CONSTRAINT __text_<slug>__check
 * CHECK (VALUE IS NULL OR (...) IS TRUE)`, with no NOT NULL: text in pg_c_utf8 under the pattern's membership.
 */
export const textDomainDefinition = (
	check: RegexCheck
): { readonly base: TypeRef; readonly collation: Collation; readonly check: Expr } => ({
	base: types.text,
	collation: cUtf8Collation,
	check: membership(check, domainValue)
})
