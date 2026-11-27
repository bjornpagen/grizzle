import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	isNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { DagBuilder } from "#compiler/ir/builder.ts"
import { relNode } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { comparedValue } from "#compiler/ir/injective.ts"
import {
	conservativeMeta,
	type HeadingColumn,
	type KeySet,
	type NodeOf,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { equalityIsIdentity, typeLabel } from "#compiler/ir/scalar.ts"
import type { LogicalAnalysis } from "#compiler/logical/annotate.ts"
import { fixedColumns, identifiesFacts, readColumns } from "#compiler/logical/props.ts"
import { canonicalSpec } from "#compiler/scalar/compute/registry.ts"

/**
 * A float's two zeros are one value under PostgreSQL's equality, a float's the one carrier whose equality is no
 * identity (ir/scalar.ts equalityIsIdentity), and every relational operation compares by it: a set,
 * a key, a join, a group. So an operation that takes one value for several equal ones, a set's member for each class of
 * equal rows, a group's key, a union's row, a recursion's state, may take either zero, and PostgreSQL's choice is its
 * plan's: a hash keeps the first row it meets, a sort the first of a run its unstable quicksort leaves, a parallel plan
 * the first a worker hands it. grizzle's own lowerings choose apart too: the conservative one deduplicates at every
 * node, the optimized one once, where its first consumer reads repeats, and a rewrite may read a join variable from
 * another of its fields. A navigation keeps each binding (analysis/theory/navigate.ts #chain): a step that reads a float
 * variable an earlier step bound delivers it again, bound to it, so a navigated rule's variables are of two equal values
 * where the written rule's are.
 *
 * So wherever an operation may take one float for several equal ones, the float it delivers is the canonical zero, +0,
 * row by row (scalar/compute/registry.ts canonical, `x + 0`: IEEE 754's -0 + +0 is +0, and JavaScript's Set and Map
 * hold +0 for -0): what deduplicates then meets one value for every class, and every plan and both lowerings deliver
 * it, wherever they deduplicate. Every scalar operation gives equal results of equal operands, a quotient by zero
 * included (scalar/compute/evaluate.ts quotient), so a value computed from a merged one differs between plans in a
 * zero's sign at most, which the canonical zero erases. A float that is one fact's field wherever its row is delivered
 * keeps its sign: a stored -0 a keyed read delivers is -0. A ChangeSet member root's rows are the facts its write
 * states, a set by fact identity, which the write forms at its input (write/insert/input.ts inputSet), so neither its
 * head nor its union's arms are a stated merge (check/checker.ts RowsOf): its write stores the -0 its caller states.
 *
 * A float a rule delivers is one fact's field when every variable it reads is (pickFree): a variable bound by one field
 * of one match whose source fields, those bound to a variable the delivered row determines and those a constant fixes,
 * tell the source's rows apart as facts (logical/props.ts identifiesFacts: a key of the source, or its whole heading
 * where its rows are a set's members, a relation parameter's facts among them, two of which may be natively equal), so
 * two matches that deliver one row match one fact there; or a variable no match binds, a parameter's or an outer
 * value's, one per evaluation. A variable bound by two fields, of two facts that are equal, is one of two equal values.
 *
 * A stated merge is a projection whose floats a merge may take, which the checker records as it builds it, with its
 * rule, settled under the checked DAG's logical analysis (canonicalMerges):
 *
 * - `always`: an arm of a union beside another arm of its heading group, whose rows the union may take for another
 *   arm's, and a recursion's state, which its recursive UNION merges across its iterations: every float;
 * - `matches`: a rule's head: each float whose variables are not each one fact's field, the delivered row determining
 *   the fields its input delivers as they are and the fields fixed per evaluation (logical/props.ts fixedColumns).
 *
 * A grouped head's projection takes its keys' canonical zeros as the checker builds it, by the same rule over the
 * group's keys and the matches' declared keys (checker.ts #grouped), and every float where a float variable is one of
 * two equal values.
 */
export type MergeRule =
	| { readonly kind: "always" }
	| { readonly kind: "matches"; readonly input: RelNode; readonly region: RegionMatches }

/** A rule's match of one source: the source fields it binds, each to its variable, and those it fixes to a constant. */
interface Match {
	readonly source: RelNode
	readonly bindings: ReadonlyArray<{ readonly column: string; readonly variable: string }>
	readonly constants: ReadonlyArray<string>
}

/** What a rule's region states of its matches for a merge's rule (regionMatches). */
export interface RegionMatches {
	readonly matches: ReadonlyArray<Match>
	/** The float variables bound by two fields, or by a field and the outer value they are correlated with. */
	readonly joined: ReadonlyArray<string>
}

/** A projection whose floats a merge may take, with its rule and where it stands (MergeRule). */
export interface StatedMerge {
	readonly projection: NodeOf<"ProjectSet">
	readonly rule: MergeRule
	readonly at: SourceLoc
}

/**
 * A rule region's matches, each by the source fields it binds, and its float variables of two equal values: one bound
 * by two fields, or by a field and the outer value it is correlated with, whichever the lowering reads it from, which a
 * rewrite may move (an occurrence moved into a semi-join, or eliminated through a containment).
 */
export const regionMatches = (
	region: Pick<NodeOf<"MatchRegion">, "vars" | "occurrences" | "correlated">
): RegionMatches => {
	const binders = new Map<VarDecl, number>()
	const bind = (v: VarDecl): void => {
		binders.set(v, (binders.get(v) ?? 0) + 1)
	}
	for (const o of region.occurrences) {
		for (const b of o.bindings) {
			bind(b.var)
		}
	}
	for (const c of region.correlated) {
		bind(c.var)
	}
	return {
		matches: region.occurrences.map((o) => ({
			source: o.source,
			bindings: o.bindings.map((b) => ({ column: b.column, variable: b.var.name })),
			constants: o.constants.map((c) => c.column)
		})),
		joined: region.vars
			.filter((v) => !equalityIsIdentity(v.type) && (binders.get(v) ?? 0) >= 2)
			.map((v) => v.name)
	}
}

/**
 * Whether `variable` is one fact's field wherever a row that determines the variables `determined` is delivered:
 * bound by no match, or bound once by a match whose fields `determined` and its constants fix hold a key of its source,
 * as `keyed` judges a source's fields; never a variable of two equal values (RegionMatches joined).
 */
export const pickFree = (
	region: RegionMatches,
	determined: ReadonlySet<string>,
	keyed: (source: RelNode, fields: ReadonlyArray<string>) => boolean,
	variable: string
): boolean => {
	if (region.joined.includes(variable)) {
		return false
	}
	const match = region.matches.find((m) => m.bindings.some((b) => b.variable === variable))
	return (
		match === undefined ||
		keyed(match.source, [
			...match.constants,
			...match.bindings.filter((b) => determined.has(b.variable)).map((b) => b.column)
		])
	)
}

/**
 * The keys of a matched source, narrowest first as its declaration states them: a relation's primary key and every
 * further key, a view's proved keys then its whole heading, a closed relation's key (`closedKey` of its name, undefined
 * for one no schema holds), a delta's relation's keys, the empty key of a context's one fact, and the whole heading of
 * any other source (a relation parameter, a matched query or stage, a recursion's feedback), which is a set keyed by
 * its heading.
 */
export const declaredKeys = (
	source: RelNode,
	closedKey: (closed: string) => KeySet | undefined
): NonEmptyReadonlyArray<KeySet> => {
	const heading = source.heading.map((c) => c.name)
	switch (source.kind) {
		case "Base":
			return source.relationKind === "relation"
				? [source.primaryKey, ...source.keys]
				: appendNonEmpty<KeySet>(
						source.view.map((k) => k.fields),
						heading
					)
		case "Closed":
			return [closedKey(source.closed) ?? heading]
		case "Context":
			return [[]]
		case "Delta":
			return isNonEmpty(source.keys) ? source.keys : [heading]
		case "InputSet":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
		case "Step":
		case "Call":
			return [heading]
	}
}

/**
 * Which floats a grouped head delivers as their canonical zero, where a group may take one as one of several equal
 * ones: a key whose variable is no one fact's field across the rows of its group (pickFree, the group's keys
 * `groupKeys` determining the variables, each match's declared keys, `keysOf`, judging its fields), a computed key, a
 * column `input` does not hold, and every float where a float variable is of two equal values. A correlation's key is
 * the parent's value its stitch compares by its equality, which delivers no value, and keeps its column.
 */
export const groupedZeroed = (
	region: RegionMatches,
	input: ReadonlyArray<HeadingColumn>,
	groupKeys: ReadonlySet<string>,
	keysOf: (source: RelNode) => NonEmptyReadonlyArray<KeySet>
): ((c: HeadingColumn, delivered: "correlation" | "key" | "result") => boolean) => {
	const keyedBy = (source: RelNode, fields: ReadonlyArray<string>): boolean =>
		keysOf(source).some((k) => k.every((f) => fields.includes(f)))
	const oneFact = (c: HeadingColumn): boolean =>
		input.some((h) => h.name === c.name) && pickFree(region, groupKeys, keyedBy, c.name)
	return (c, delivered) =>
		delivered !== "correlation" &&
		!equalityIsIdentity(c.type) &&
		(region.joined.length > 0 || (delivered === "key" && !oneFact(c)))
}

/**
 * The columns of `input` a projection's outputs deliver as they are: each output whose compared value
 * (ir/injective.ts comparedValue) is a column of `input`, which the delivered row determines.
 */
const copiedColumns = (
	out: ReadonlyArray<{ readonly expr: ScalarExpr }>,
	input: RelNode
): ReadonlyArray<string> =>
	out.flatMap((o) => {
		const value = comparedValue(o.expr)
		return value.kind === "column" && value.column.node === input.id ? [value.column.name] : []
	})

/** Whether a projection delivers a value of a type whose equality is no identity (ir/scalar.ts equalityIsIdentity), which a
 * stated merge may need to canonicalize. */
export const deliversNonIdentity = (projection: NodeOf<"ProjectSet">): boolean =>
	projection.out.some((o) => !equalityIsIdentity(o.expr.type))

/**
 * The outputs of a stated merge's projection that take the canonical zero, under the checked DAG's logical analysis:
 * every float for `always`; for a head, each float that reads a variable that is not one fact's field (pickFree).
 */
const canonicalOuts = (analysis: LogicalAnalysis, merge: StatedMerge): ReadonlySet<string> => {
	const p = merge.projection
	const floats = p.out.filter((o) => !equalityIsIdentity(o.expr.type))
	const rule = merge.rule
	switch (rule.kind) {
		case "always":
			return new Set(floats.map((o) => o.name))
		case "matches": {
			const determined = new Set([
				...copiedColumns(p.out, rule.input),
				...fixedColumns(
					defined(analysis.props.get(rule.input), "a merge's input, kept (mergeReads)")
				)
			])
			const keyed = (source: RelNode, fields: ReadonlyArray<string>): boolean =>
				identifiesFacts(
					defined(analysis.props.get(source), "a matched source, kept (mergeReads)"),
					fields
				)
			return new Set(
				floats
					.filter((o) =>
						readColumns(o.expr, rule.input.id).some(
							(v) => !pickFree(rule.region, determined, keyed, v)
						)
					)
					.map((o) => o.name)
			)
		}
	}
}

/**
 * The nodes a stated merge's rule reads the properties of (canonicalMerges): a rule of matches reads its input's fixed
 * columns and each matched source's keys; `always` reads none.
 */
export const mergeReads = (merge: StatedMerge): ReadonlyArray<RelNode> => {
	const rule = merge.rule
	switch (rule.kind) {
		case "always":
			return []
		case "matches":
			return [rule.input, ...rule.region.matches.map((m) => m.source)]
	}
}

/** The canonical form of a term of a non-identity equality type, of its type (scalar/compute/registry.ts canonicalSpec),
 * built by `b`. */
const canonicalOf = (b: DagBuilder, expr: ScalarExpr): ScalarExpr => {
	const spec = canonicalSpec(expr)
	if (spec === undefined) {
		defect(`a canonical form of ${typeLabel(expr.type)}`)
	}
	return b.expr(spec)
}

/**
 * Each stated merge of a projection `reachable` holds, restated under its own label with every output its rule settles
 * (canonicalOuts) the canonical zero of its term, built by `b`, under `analysis`, the checked DAG's: a projection none
 * of whose outputs it settles is kept as it is.
 */
export const canonicalMerges = (
	analysis: LogicalAnalysis,
	reachable: ReadonlySet<RelNode>,
	stated: ReadonlyMap<RelNode, StatedMerge>,
	b: DagBuilder
): ReadonlyMap<RelNode, RelNode> => {
	const merged = new Map<RelNode, RelNode>()
	for (const [node, merge] of stated) {
		if (!reachable.has(node)) {
			continue
		}
		const canonical = canonicalOuts(analysis, merge)
		if (canonical.size === 0) {
			continue
		}
		const p = merge.projection
		const out = p.out.map((o) =>
			canonical.has(o.name) ? { name: o.name, expr: canonicalOf(b, o.expr) } : o
		)
		merged.set(
			node,
			relNode(p.id, {
				kind: "ProjectSet",
				input: p.input,
				out,
				heading: p.heading,
				loc: merge.at,
				meta: conservativeMeta
			})
		)
	}
	return merged
}
