import type { RefinementPlugin } from "#compiler/check/context.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	baseOf,
	numericBoundOf,
	numericTypmodOf,
	type PlainType,
	regexOf,
	sameScalarType,
	type ScalarType,
	textOf
} from "#compiler/ir/scalar.ts"

import {
	commonType,
	compatible,
	exactNumericBound,
	numericHull,
	sameRegex,
	wildcardText
} from "#compiler/scalar/compute/types.ts"
import { languageIncludes, languageOf, type PatternDfas } from "#compiler/scalar/regex/inclusion.ts"
import { numericValue } from "#compiler/scalar/registry.ts"

/** The numeric half of `guarantees`: `b`'s typmod `a`'s own where it has one, and its bound holding `a`'s values. */
const numericGuarantees = (ba: PlainType, bb: PlainType): boolean => {
	const ta = numericTypmodOf(ba)
	const tb = numericTypmodOf(bb)
	if (tb !== undefined && (ta?.precision !== tb.precision || ta.scale !== tb.scale)) {
		return false
	}
	const boundB = numericBoundOf(bb)
	const boundA = exactNumericBound(ba)
	return (
		boundB === undefined ||
		(boundA !== undefined && boundA.digits <= boundB.digits && boundA.scale <= boundB.scale)
	)
}

/**
 * Whether every value of type `a` is proved to be a value of type `b`: one carrier and nominal identity, the contract
 * chain included (compatible: within one checked schema a contract name names one domain), one numeric typmod, a
 * computed numeric's bound holding `a`'s values (types.ts exactNumericBound), and, for text, `b` the canonical wildcard,
 * or `a`'s language within its byte bound proved inside `b`'s and within `b`'s bound by their automata, read from
 * `patterns` (scalar/regex/inclusion.ts languageIncludes): a LearnerId of 69 bytes is a Timeback user of 255
 * characters, though `^.+$` lies inside `^.{1,255}$` only within the bound. A construction past the text analysis's
 * bounds proves nothing.
 */
export const guarantees = (a: ScalarType, b: ScalarType, patterns: PatternDfas): boolean => {
	if (!compatible(a, b)) {
		return false
	}
	const ba = baseOf(a)
	const bb = baseOf(b)
	if (ba.carrier === "numeric" && !numericGuarantees(ba, bb)) {
		return false
	}
	if (ba.carrier === "text" && bb.carrier === "text") {
		if (bb.text === "wildcard" || sameRegex(ba.text, bb.text)) {
			return true
		}
		const inner = regexOf(ba.text)
		const outer = regexOf(bb.text)
		return (
			inner !== undefined &&
			outer !== undefined &&
			languageIncludes(languageOf(inner), languageOf(outer), patterns) === "included"
		)
	}
	return true
}

/** Whether two compatible numerics make the same guarantees in both directions (numericGuarantees). */
const sameNumericGuarantees = (a: ScalarType, b: ScalarType): boolean =>
	compatible(a, b) &&
	numericGuarantees(baseOf(a), baseOf(b)) &&
	numericGuarantees(baseOf(b), baseOf(a))

/**
 * The common type of two compatible arm types, the least upper bound grizzle can state of them: one contract identity,
 * which compatible arms share, the contract's domain guaranteeing both arms' values; for two texts, the one whose
 * language within its bound holds the other's (guarantees), the outer one, and the wildcard where neither does. A
 * union's column delivers one of its arms' own refinements or none: a language holding both that neither arm declares
 * (their union, a byte-bounded text of any characters) is no type of the schema's, whose domain no installation holds,
 * so of the types grizzle can state, the arms' and the wildcard, the outer arm's is the least that holds both, and the
 * wildcard where neither holds the other. Two state names and the slugs that hold them join at the slugs.
 */
const combine = (x: ScalarType, y: ScalarType, patterns: PatternDfas): ScalarType => {
	if (sameScalarType(x, y)) {
		return x
	}
	if (x.contract !== undefined) {
		return x
	}
	if (x.carrier === "text" && y.carrier === "text") {
		return sameRegex(x.text, textOf(y)) || guarantees(y, x, patterns)
			? x
			: guarantees(x, y, patterns)
				? y
				: wildcardText
	}
	const nx = exactNumericBound(x)
	const ny = exactNumericBound(y)
	if (x.carrier === "numeric" && nx !== undefined && ny !== undefined) {
		return sameNumericGuarantees(x, y) ? x : numericValue(numericHull(nx, ny))
	}
	return commonType(x, y)
}

/**
 * Refinement propagation and the refinement validation sites.
 *
 * Every text value in the checked IR carries a specific pattern or the canonical wildcard, and every contract value its
 * contract. This module owns what the checker cannot decide locally about those guarantees:
 *
 * - Propagation. An unchanged projection, match, import, DISTINCT, and text min and max keep their input's
 *   guarantees, because the checker gives them the input column's own type. A computed value carries the scalar
 *   catalogue's result type, a plain native type, a computed numeric with its bound or the canonical wildcard
 *   (scalar/compute). A column that several arms
 *   of one union deliver keeps only the guarantees common to every arm (`refinement.common` below): the arms' type when
 *   they agree, the arms' pattern when the arms' patterns are proved to recognize one language (the canonical
 *   pattern key of text/refinement.ts, the proof domain sharing uses), the outer arm's where its language within its
 *   bound holds the other's (guarantees), and otherwise the canonical wildcard for text
 *   and, for numerics, the computed numeric whose bound holds both arms' values (types.ts numericHull): PostgreSQL's
 *   own common-type rule, text and numeric of no typmod, with what grizzle proves of it. No disjointness, or
 *   inferred-type assignability, is claimed.
 * - Validation sites. A value written into a refined column is validated by the column's domain in the apply
 *   transaction; its refusal names the domain's constraint; the adapter classifies it by the domain PostgreSQL reports
 *   as the violation's data type. A refined output is cast to its domain in the delivered output list
 *   (lower/shapes/refined). A comparison parameter is bound as the base and is never validated. Closed payloads with
 *   nontrivial refinements are validated by PostgreSQL at installation: `refinedConstants` lists them, and
 *   lower/shapes/refined builds the statement that casts each to its domain and the installer extension that runs it
 *   in the Publish phase. No path validates a query's own refined literals, so the delivery relies on no base-typed
 *   constant's membership and casts it where it is delivered.
 *
 * The host never validates application data: the canonical pattern keys come from the text package's bounded automaton
 * construction over declarations, never from a matcher run over values.
 */
export const refinement: RefinementPlugin = {
	common: (types, patterns) => {
		const [first, ...rest] = types
		return rest.reduce((a, b) => combine(a, b, patterns), first)
	}
}

/**
 * Whether a value of `t` needs PostgreSQL's validation where it enters a refined position: a contract whose domain, or
 * whose base's domain, carries a CHECK, or text with a specific pattern. A brand-only contract over an unrefined base
 * has no constraint to evaluate.
 */
export const hasConstraint = (t: ScalarType): boolean => {
	const { contract } = t
	if (contract !== undefined) {
		return contract.predicate !== undefined || hasConstraint(contract.base)
	}
	return t.carrier === "text" && regexOf(t.text) !== undefined
}

/**
 * Where a refined constant is declared: the closed relation, its payload field, and the key of its row, each key
 * field's literal in the relation's key order.
 */
export interface RefinedSite {
	readonly relation: string
	readonly field: string
	readonly key: ReadonlyArray<TypedLiteral>
}

/**
 * A refined constant the compiler relies on: a closed relation's payload value of a type whose domain carries a CHECK.
 * PostgreSQL validates it at installation.
 */
export interface RefinedConstant {
	readonly literal: TypedLiteral
	readonly type: ScalarType
	readonly site: RefinedSite
}

/**
 * The closed relations' payload values whose fields carry a nontrivial refinement, in relation, row and heading order.
 * A closed relation's heading is its key fields, then its payload, so a row's first `primaryFields.length` literals
 * are its key, which names the row, and the rest its payload; a roster's one field is its key.
 */
export const refinedConstants = (schema: SchemaReading): ReadonlyArray<RefinedConstant> =>
	[...schema.closed.values()].flatMap((info) => {
		const keyed = info.relation.primaryFields.length
		return info.rows.flatMap((row) => {
			const key = row.slice(0, keyed)
			return info.heading.flatMap((column, i): ReadonlyArray<RefinedConstant> => {
				const literal = row[i]
				return i < keyed || literal === undefined || !hasConstraint(column.type)
					? []
					: [
							{
								literal,
								type: column.type,
								site: { relation: info.name, field: column.name, key }
							}
						]
			})
		})
	})
