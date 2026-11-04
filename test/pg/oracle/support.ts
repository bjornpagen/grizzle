import type { Gen } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record, String as Str } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import { nativeEqualityKey, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { RelKind } from "#compiler/ir/rel.ts"
import type { GenConfig, QueryCase } from "#test/support/oracle/gen/case.ts"
import type { SpelledValue } from "#test/support/oracle/gen/domain.ts"
import { queryExprs, queryGenerators } from "#test/support/oracle/gen/query.ts"
import { isPureSet } from "#test/support/oracle/gen/schema.ts"
import { rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { type DeclineReason, declineReasons } from "#test/support/oracle/reference/values.ts"

export const operatorKinds = [
	"MatchRegion",
	"Filter",
	"ProjectSet",
	"SemiJoin",
	"AntiJoin",
	"Union",
	"Intersect",
	"Difference",
	"Group",
	"Take",
	"Attach",
	"Recursive",
	"Closed",
	"InputSet"
] as const satisfies ReadonlyArray<RelKind>

/**
 * What a case of the conservative gate's population exercises; what only the real installer adds to its plan, a
 * structural `__text_` domain and a foreign key the write scope defers; and "nonempty": its conservative run delivered a
 * row.
 */
export type ConservativeFeature =
	| `relations:${1 | 2 | 3 | 4}`
	| "composite primary key"
	| "candidate key"
	| "composite candidate key"
	| "pure set"
	| "mutable relation"
	| "closed roster"
	| "containment"
	| "NaN fact"
	| "-0 fact"
	| "scaled numeric fact"
	| "supplementary-plane text fact"
	| "numeric spelling mismatch"
	| (typeof operatorKinds)[number]
	| "scalar parameter"
	| "relation parameter"
	| "parameter take bound"
	| "nested attach"
	| "text domain"
	| "deferred foreign key"
	| "nonempty"
	| "facts reordered"
	| "a fact respelled"
	| `declined ${DeclineReason}`

/**
 * The feature a suite notes for each way its reference declines to judge a term (reference/values.ts DeclineReason):
 * the features whose rates every reference-judged suite reports beside its residual (features.ts rating).
 */
export const declineFeatures: Arr.NonEmptyReadonlyArray<`declined ${DeclineReason}`> = Arr.map(
	declineReasons,
	(reason) => `declined ${reason}` as const
)

/** The relation count of a case, which the generator's limits keep within one to four. */
const relationsFeature = (count: number): ConservativeFeature => {
	switch (count) {
		case 1:
			return "relations:1"
		case 2:
			return "relations:2"
		case 3:
			return "relations:3"
		case 4:
			return "relations:4"
	}
	throw new Error(`a case over ${count} relations, outside the generator's limits of one to four`)
}

/** A numeric stored with trailing fractional zeros past its least scale: a twin spelling of its value. */
const isScaled = (v: SpelledValue): boolean =>
	v.literal.kind === "numeric" && v.spelling.kind === "twin"

const isNaNLiteral = (l: TypedLiteral): boolean =>
	(l.kind === "numeric" && decimalPayload(l.value) === "NaN") ||
	(l.kind === "floatSpecial" && l.value === "NaN")

/** A float zero stored as -0, its twin spelling. */
const isNegativeZero = (v: SpelledValue): boolean =>
	v.literal.kind === "float" && v.spelling.kind === "twin"
const isSupplementary = (l: TypedLiteral): boolean =>
	l.kind === "text" &&
	Arr.some(Array.from(l.value), (ch) =>
		Option.exists(Str.codePointAt(ch, 0), (point) => point > 0xffff)
	)

/**
 * Shared pieces of the oracle suites.
 *
 * caseFeatures names what one generated case exercises, so a suite can require it: the gate asks for cases over one to
 * four relations with composite and candidate keys, closed rosters and pure sets, small-domain facts including NaN,
 * -0 and display scales (1.0 vs 1.00) in their stored spellings, and supplementary-plane text, scalar and relation parameters, and queries over
 * every operator of the generator fragment. The property notes them through its case (S-KERNEL).
 *
 * The features of one case.
 *
 * A comparison operand equal to a value stored in a twin spelling: 1.0 against a stored 1.00.
 */
export const caseFeatures = (c: QueryCase): ReadonlyArray<ConservativeFeature> => {
	const out = new Set<ConservativeFeature>()
	out.add(relationsFeature(c.schema.relations.length))
	for (const r of c.schema.relations) {
		if (r.primaryKey.length > 1 && !isPureSet(r)) {
			out.add("composite primary key")
		}
		if (r.keys.length > 0) {
			out.add("candidate key")
		}
		if (Arr.some(r.keys, (k) => k.length > 1)) {
			out.add("composite candidate key")
		}
		if (isPureSet(r)) {
			out.add("pure set")
		}
		if (r.mutable) {
			out.add("mutable relation")
		}
	}
	if (c.schema.closed.length > 0) {
		out.add("closed roster")
	}
	if (c.schema.containments.length > 0) {
		out.add("containment")
	}
	const twinned = new Set<string>()
	for (const v of Record.values(c.facts).flat(2)) {
		if (isNaNLiteral(v.literal)) {
			out.add("NaN fact")
		}
		if (isNegativeZero(v)) {
			out.add("-0 fact")
		}
		if (isScaled(v)) {
			out.add("scaled numeric fact")
			twinned.add(nativeEqualityKey(v.literal))
		}
		if (isSupplementary(v.literal)) {
			out.add("supplementary-plane text fact")
		}
	}
	for (const e of queryExprs(c.query.dag)) {
		if (
			e.kind === "literal" &&
			e.value.kind === "numeric" &&
			twinned.has(nativeEqualityKey(e.value))
		) {
			out.add("numeric spelling mismatch")
		}
	}
	for (const p of Record.values(c.query.params)) {
		out.add(p.kind === "scalar" ? "scalar parameter" : "relation parameter")
	}
	for (const n of topoOrder(c.query.dag)) {
		const operator = Arr.findFirst(operatorKinds, (k) => k === n.kind)
		if (Option.isSome(operator)) {
			out.add(operator.value)
		}
		if (n.kind === "Take" && n.bound.kind === "param") {
			out.add("parameter take bound")
		}
		if (n.kind === "Attach" && n.child.kind === "Attach") {
			out.add("nested attach")
		}
	}
	return [...out]
}

/**
 * The generator's cases with denser facts: three to six sketched rows for every relation slot instead of zero to six.
 * The default population leaves many relations empty and so many results empty; this one makes joins, fanout, groups
 * and projected duplicates meet real rows. Everything else is the generator's own resolution.
 */
export const denseQueryCaseGen = (config: GenConfig): Gen<QueryCase> =>
	rootedCaseGen(queryGenerators(config.query).root, config)
