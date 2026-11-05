import { Array as Arr, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import { nativeEqualityKey } from "#compiler/ir/expr.ts"
import type { NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import type {
	ConservativeProgram,
	ConservativeStatement
} from "#compiler/lower/conservative/types.ts"
import type { Select, SelectBody, SelectCore, SetOperand, SetOperation } from "#compiler/sql/ast.ts"
import { and, conjunction, exists, lit, simpleSelect, target, types } from "#compiler/sql/build.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { opMeaning } from "#test/support/oracle/gen/ops.ts"
import {
	aliasOrigins,
	conjuncts,
	identityVisitor,
	readsAlias,
	rewriteProgram,
	rewriteSelect,
	topLevelContext,
	type Visitor,
	withoutDistinct
} from "#test/support/oracle/mutants/ast.ts"
import { immediateKeys, KeyAnalysis, neverDrops } from "#test/support/oracle/mutants/keys.ts"

const mutantIds = [
	"V1",
	"V2",
	"V3",
	"V4",
	"V5",
	"V6",
	"I1",
	"I2",
	"I3",
	"I4",
	"I5",
	"I6",
	"I7",
	"I8"
] as const
export type MutantId = (typeof mutantIds)[number]

interface Mutation {
	readonly program: ConservativeProgram
	/** How many rewrites the mutant made; 0 when the case has nothing its rule applies to. */
	readonly sites: number
}

export interface Mutant {
	readonly id: MutantId
	readonly valid: boolean
	/** The check the mutant stands for. */
	readonly check: string
	/** The mutated program of a case. */
	readonly mutate: (
		program: ConservativeProgram,
		c: QueryCase
	) => Result.Result<Mutation, CompileError>
}

/** A statement visitor for one statement and a site counter. */
type StatementVisitor = (count: () => void, statement: ConservativeStatement) => Visitor

const byVisitor =
	(visitor: StatementVisitor) =>
	(program: ConservativeProgram): Result.Result<Mutation, CompileError> => {
		let sites = 0
		const count = () => {
			sites++
		}
		const rewritten = rewriteProgram(program, (statement) =>
			rewriteSelect(
				statement.ast,
				aliasOrigins(statement),
				visitor(count, statement),
				topLevelContext
			)
		)
		return Result.map(rewritten, (p) => ({ program: p, sites }))
	}

/**
 * The node of a DAG a lowered statement's alias names by its label (ast.ts aliasOrigins), or undefined for one that
 * names none: the DAG's labels, gathered by one walk for one mutation.
 */
const labelled = (dag: RelDag): ((id: NodeId | undefined) => RelNode | undefined) => {
	const index = nodesByLabel(dag)
	return (id) => (id === undefined ? undefined : index.get(id))
}

/** Removes the DISTINCT of every node the analysis drops. */
const dropDistinct = (analysis: KeyAnalysis): StatementVisitor => {
	const nodeOf = labelled(analysis.dag)
	return (count) => ({
		...identityVisitor,
		derived: (query, node) => {
			const n = nodeOf(node)
			if (n === undefined || !analysis.dropped(n)) {
				return query
			}
			const mutated = withoutDistinct(query)
			if (mutated === undefined) {
				return query
			}
			count()
			return mutated
		}
	})
}

/** A Group's contributions: the DISTINCT core without GROUP BY its lowering reads (group/index.ts). */
const isContributions = (query: Select): boolean =>
	query.body.kind === "core" && query.body.distinct === true && query.body.groupBy.length === 0

const dropContributions = (
	dag: RelDag,
	applies: (group: NodeOf<"Group">) => boolean
): StatementVisitor => {
	const nodeOf = labelled(dag)
	return (count) => ({
		...identityVisitor,
		derived: (query, node) => {
			const n = nodeOf(node)
			if (n?.kind !== "Group" || !isContributions(query) || !applies(n)) {
				return query
			}
			const mutated = withoutDistinct(query)
			if (mutated === undefined) {
				return query
			}
			count()
			return mutated
		}
	})
}

const unionAll = (body: SelectBody): SelectBody => {
	if (body.kind !== "setOp") {
		return body
	}
	return { ...body, op: body.op === "UNION" ? "UNION ALL" : body.op }
}

const toUnionAll = (
	dag: RelDag,
	applies: (union: NodeOf<"Union">) => boolean
): StatementVisitor => {
	const nodeOf = labelled(dag)
	return (count) => ({
		...identityVisitor,
		derived: (query, node) => {
			const n = nodeOf(node)
			if (
				n?.kind !== "Union" ||
				n.groups.length !== 1 ||
				query.body.kind !== "setOp" ||
				!applies(n)
			) {
				return query
			}
			count()
			return { ...query, body: unionAll(query.body) }
		}
	})
}

/** The recursive CTE's UNION of a Recursive node's lowering (recursive/index.ts). */
const recursiveTerms = (query: Select): Select | undefined => {
	const cte = query.with?.recursive === true ? query.with.ctes[0] : undefined
	return cte?.query.kind === "select" && cte.query.body.kind === "setOp" ? cte.query : undefined
}

const withRecursiveBody = (query: Select, body: Select): Select => {
	const w = query.with
	if (w === undefined) {
		return query
	}
	const [first, ...rest] = w.ctes
	return { ...query, with: { ...w, ctes: [{ ...first, query: body }, ...rest] } }
}

/** The seed or step term: SELECT casts FROM (<node>) AS r(...), with the node's DISTINCT removed. */
const plainTerm = (term: SetOperand): SetOperand | undefined => {
	if (term.kind !== "core") {
		return undefined
	}
	const [item] = term.from
	if (item?.kind !== "derived") {
		return undefined
	}
	const query = withoutDistinct(item.query)
	if (query === undefined) {
		return undefined
	}
	return { ...term, from: [{ ...item, query }, ...term.from.slice(1)] }
}

const recursiveVisitor = (
	dag: RelDag,
	applies: (r: NodeOf<"Recursive">) => boolean,
	rewrite: (terms: Select) => Select | undefined
): StatementVisitor => {
	const nodeOf = labelled(dag)
	return (count) => ({
		...identityVisitor,
		derived: (query, node) => {
			const n = nodeOf(node)
			if (n?.kind !== "Recursive" || !applies(n)) {
				return query
			}
			const terms = recursiveTerms(query)
			const next = terms === undefined ? undefined : rewrite(terms)
			if (next === undefined) {
				return query
			}
			count()
			return withRecursiveBody(query, next)
		}
	})
}

/**
 * Whether a closure's edges are filtered to src < dst: its base projects (src, dst) from a Filter by the `lt` of the
 * two columns, as the generator's acyclic closure does (gen/query.ts).
 */
const isAcyclicClosure = (r: NodeOf<"Recursive">): boolean => {
	const base = r.base
	if (base.kind !== "ProjectSet") {
		return false
	}
	const filter = base.input
	if (filter.kind !== "Filter") {
		return false
	}
	const pred = filter.pred
	if (pred.kind !== "op" || opMeaning(pred.op)?.kind !== "compare") {
		return false
	}
	const meaning = opMeaning(pred.op)
	if (meaning?.kind !== "compare" || meaning.op !== "lt") {
		return false
	}
	/** Whether the projection's output `name` is the column `column`. */
	const projects = (name: string, column: string): boolean =>
		Option.exists(
			Arr.findFirst(base.out, (o) => o.name === name),
			(out) => out.expr.kind === "column" && out.expr.column.name === column
		)
	const [a, b] = pred.args
	return (
		a?.kind === "column" &&
		b?.kind === "column" &&
		projects("src", a.column.name) &&
		projects("dst", b.column.name)
	)
}

/** Whether a union's arms are each a projection whose `tag` column is a literal, the literals pairwise distinct. */
const hasDisjointTags = (u: NodeOf<"Union">): boolean => {
	const arms = Arr.flatMap(u.groups, (g) => g.arms)
	if (!Arr.some(u.heading, (c) => c.name === "tag") || arms.length < 2) {
		return false
	}
	const tags: Array<string> = []
	for (const n of arms) {
		if (n.kind !== "ProjectSet") {
			return false
		}
		const tag = Option.map(
			Arr.findFirst(n.out, (o) => o.name === "tag"),
			(out) => out.expr
		)
		if (Option.isNone(tag) || tag.value.kind !== "literal") {
			return false
		}
		tags.push(nativeEqualityKey(tag.value.value))
	}
	return new Set(tags).size === tags.length
}

/**
 * V3: the occurrence of a region that is only a witness: its every bound variable is bound by an earlier occurrence,
 * so no output reads it. The last such occurrence, when the others keep a key.
 */
const witnessOf = (analysis: KeyAnalysis, region: NodeOf<"MatchRegion">): number | undefined => {
	if (region.occurrences.length < 2 || region.correlated.length > 0) {
		return undefined
	}
	for (let w = region.occurrences.length - 1; w > 0; w--) {
		const o = region.occurrences[w]
		if (o === undefined) {
			continue
		}
		const earlier = new Set(
			Arr.flatMap(region.occurrences.slice(0, w), (p) => Arr.map(p.bindings, (b) => b.var))
		)
		if (!Arr.every(o.bindings, (b) => earlier.has(b.var))) {
			continue
		}
		const rest = Arr.filter(
			Arr.map(indices(region.occurrences.length), (i) => i),
			(i) => i !== w
		)
		return analysis.regionKeys(region, rest).length > 0 ? w : undefined
	}
	return undefined
}

const witnessVisitor = (analysis: KeyAnalysis): StatementVisitor => {
	const nodeOf = labelled(analysis.dag)
	return (count, statement) => {
		const origins = aliasOrigins(statement)
		return {
			...identityVisitor,
			/** The FROM items are the occurrences' sources in declared order (match-region/index.ts). */
			derived: (query, node) => {
				const region = nodeOf(node)
				if (region?.kind !== "MatchRegion" || query.body.kind !== "core") {
					return query
				}
				const w = witnessOf(analysis, region)
				if (w === undefined) {
					return query
				}
				const core: SelectCore = query.body
				const from = core.from
				if (
					from.length !== region.occurrences.length ||
					!Arr.every(
						from,
						(f, i) =>
							f.kind === "derived" && origins.get(f.alias) === region.occurrences[i]?.source.id
					)
				) {
					return query
				}
				const witness = from[w]
				if (witness?.kind !== "derived") {
					return query
				}
				const others = Arr.flatMap(from, (source, i) => (i !== w ? [source] : []))
				if (
					Arr.some(core.targets, (t) => readsAlias(t.expr, witness.alias)) ||
					Arr.some(others, (f) => f.kind === "derived" && f.lateral)
				) {
					return query
				}
				const moved = Arr.filter(conjuncts(core.where), (e) => readsAlias(e, witness.alias))
				const kept = Arr.filter(conjuncts(core.where), (e) => !readsAlias(e, witness.alias))
				const probe = simpleSelect(
					[target(lit.int(1, types.integer))],
					[witness],
					conjunction(moved)
				)
				count()
				return {
					...query,
					body: {
						...core,
						distinct: false,
						from: others,
						where: and(Arr.append(kept, exists(probe)))
					}
				}
			}
		}
	}
}

/** Removes every DISTINCT beneath an existence test (I7). */
const underExistsVisitor: StatementVisitor = (count) => ({
	...identityVisitor,
	core: (core, ctx) => {
		if (!ctx.underExists || core.distinct !== true) {
			return core
		}
		count()
		return { ...core, distinct: false }
	}
})

const immediate = (
	dag: RelDag,
	drops: (node: RelNode, derived: ReadonlyArray<ReadonlyArray<string>>) => boolean
) => new KeyAnalysis(dag, immediateKeys, drops)

const isScanLike = (n: RelNode): boolean =>
	n.kind === "Base" ||
	n.kind === "Filter" ||
	n.kind === "ProjectSet" ||
	(n.kind === "MatchRegion" && n.occurrences.length === 1)

const isJoin = (n: RelNode): n is NodeOf<"MatchRegion"> =>
	n.kind === "MatchRegion" && n.occurrences.length >= 2

/** Whether some key of the group's input lies within its bound tuple. */
const boundKeyed = (analysis: KeyAnalysis, g: NodeOf<"Group">): boolean =>
	Arr.some(analysis.keys(g.input), (k) => Arr.every(k, (c) => g.bound.columns.includes(c)))

/**
 * The mutant suite: six valid and eight invalid rewrites of the conservative output, which the harness
 * (test/pg/oracle/mutants) must accept and catch respectively.
 *
 * Each mutant is an optimizer rule applied to the conservative lowering's statements as an AST post-processor: it
 * removes a DISTINCT, moves a witness into EXISTS, or turns a UNION into UNION ALL wherever its rule claims the result
 * is already a set. A valid mutant's claim rests on evidence that holds (keys.ts); it must leave every raw multiset
 * unchanged on every case. An invalid mutant is the same kind of rule with a named flaw, applied exactly
 * where the flaw matters; the harness must find a case where it changes a multiset.
 *
 * | Id | Check | Rewrite |
 * | V1 | Retain base key | DISTINCT removed from a scan, filter, projection or single-source region whose rows keep a key |
 * | V2 | Retain both join keys | DISTINCT removed from a join region whose every source keeps a key in its bindings |
 * | V3 | Replace witness fanout with EXISTS | a source only joined, existential or fixed moved into EXISTS, DISTINCT removed |
 * | V4 | Aggregate with complete base identity retained | the contributions' DISTINCT removed when a key lies in the bound tuple |
 * | V5 | Nonrecursive union with retained disjoint arm tags | UNION ALL for a union whose unique arms carry distinct literal tags |
 * | V6 | Recursive UNION with plain seed and step SELECTs | the seed's and step's DISTINCT removed under recursive UNION |
 * | I1 | Drop base key | DISTINCT removed from a projection that keeps no key of its input |
 * | I2 | Keep only parent through fanout | DISTINCT removed from a join region with a source whose key is existential |
 * | I3 | Compute noninjective key expression | DISTINCT removed from a projection that keeps a key only through a function of it |
 * | I4 | Drop posting identity before SUM | the contributions' DISTINCT removed when no key lies in the bound tuple |
 * | I5 | Project away group keys with equal aggregate outputs | DISTINCT removed from a projection of a group that drops a group key |
 * | I6 | Disjoint source IDs projected to equal values | UNION ALL for a union without disjoint arm tags |
 * | I7 | Remove DISTINCT before OFFSET 1 under EXISTS | every DISTINCT beneath an existence test removed, a bound included |
 * | I8 | Change recursive diamond closure to UNION ALL | UNION ALL for the recursive UNION of an acyclic closure |
 *
 * The IR has no OFFSET, so I7's bounded observation is take's LIMIT k with k at least 2 beneath a semi-join's EXISTS:
 * without the DISTINCT, two copies of one value fill the bound and hide the second distinct value, as OFFSET 1
 * LIMIT 1 over repeated plans does. I8 applies only to closures whose edges are filtered to
 * src < dst, so UNION ALL still terminates.
 */
export const mutants: Readonly<Record<MutantId, Mutant>> = {
	V1: {
		id: "V1",
		valid: true,
		check: "Retain base key",
		mutate: (program, c) =>
			byVisitor(
				dropDistinct(immediate(c.query.dag, (n, derived) => isScanLike(n) && derived.length > 0))
			)(program)
	},
	V2: {
		id: "V2",
		valid: true,
		check: "Retain both join keys",
		mutate: (program, c) =>
			byVisitor(
				dropDistinct(immediate(c.query.dag, (n, derived) => isJoin(n) && derived.length > 0))
			)(program)
	},
	V3: {
		id: "V3",
		valid: true,
		check: "Replace witness fanout with EXISTS",
		mutate: (program, c) => byVisitor(witnessVisitor(immediate(c.query.dag, neverDrops)))(program)
	},
	V4: {
		id: "V4",
		valid: true,
		check: "Aggregate with complete base identity retained",
		mutate: (program, c) => {
			const analysis = immediate(c.query.dag, neverDrops)
			return byVisitor(dropContributions(c.query.dag, (g) => boundKeyed(analysis, g)))(program)
		}
	},
	V5: {
		id: "V5",
		valid: true,
		check: "Nonrecursive union with retained disjoint arm tags",
		mutate: (program, c) => byVisitor(toUnionAll(c.query.dag, (u) => hasDisjointTags(u)))(program)
	},
	V6: {
		id: "V6",
		valid: true,
		check: "Recursive UNION with plain seed and step SELECTs",
		mutate: (program, c) =>
			byVisitor(
				recursiveVisitor(
					c.query.dag,
					() => true,
					(terms) => {
						if (terms.body.kind !== "setOp") {
							return undefined
						}
						const original = terms.body.arms
						const [first, second, ...rest] = original
						const plain = (arm: SetOperand): SetOperand => plainTerm(arm) ?? arm
						const arms: SetOperation["arms"] = [
							plain(first),
							plain(second),
							...Arr.map(rest, plain)
						]
						if (Arr.every(arms, (arm, i) => arm === original[i])) {
							return undefined
						}
						return { ...terms, body: { ...terms.body, arms } }
					}
				)
			)(program)
	},
	I1: {
		id: "I1",
		valid: false,
		check: "Drop base key",
		mutate: (program, c) =>
			byVisitor(
				dropDistinct(
					immediate(c.query.dag, (n, derived) => n.kind === "ProjectSet" && derived.length === 0)
				)
			)(program)
	},
	I2: {
		id: "I2",
		valid: false,
		check: "Keep only parent through fanout",
		mutate: (program, c) =>
			byVisitor(
				dropDistinct(immediate(c.query.dag, (n, derived) => isJoin(n) && derived.length === 0))
			)(program)
	},
	I3: {
		id: "I3",
		valid: false,
		check: "Compute noninjective key expression",
		mutate: (program, c) => {
			const strict = immediate(c.query.dag, neverDrops)
			const loose = new KeyAnalysis(
				c.query.dag,
				{ ...immediateKeys, expressionsRetain: true },
				(n, derived) =>
					n.kind === "ProjectSet" && derived.length > 0 && strict.derived(n).length === 0
			)
			return byVisitor(dropDistinct(loose))(program)
		}
	},
	I4: {
		id: "I4",
		valid: false,
		check: "Drop posting identity before SUM without deduplicating the binding",
		mutate: (program, c) => {
			const analysis = immediate(c.query.dag, neverDrops)
			return byVisitor(dropContributions(c.query.dag, (g) => !boundKeyed(analysis, g)))(program)
		}
	},
	I5: {
		id: "I5",
		valid: false,
		check: "Project away group keys with equal aggregate outputs",
		mutate: (program, c) =>
			byVisitor(
				dropDistinct(
					immediate(
						c.query.dag,
						(n, derived) =>
							n.kind === "ProjectSet" && n.input.kind === "Group" && derived.length === 0
					)
				)
			)(program)
	},
	I6: {
		id: "I6",
		valid: false,
		check: "Disjoint source IDs projected to equal values",
		mutate: (program, c) => byVisitor(toUnionAll(c.query.dag, (u) => !hasDisjointTags(u)))(program)
	},
	I7: {
		id: "I7",
		valid: false,
		check: "Remove DISTINCT before OFFSET 1 under EXISTS",
		mutate: (program) => byVisitor(underExistsVisitor)(program)
	},
	I8: {
		id: "I8",
		valid: false,
		check: "Change recursive diamond closure to UNION ALL",
		mutate: (program, c) =>
			byVisitor(
				recursiveVisitor(
					c.query.dag,
					(r) => isAcyclicClosure(r),
					(terms) =>
						terms.body.kind === "setOp"
							? { ...terms, body: { ...terms.body, op: "UNION ALL" } }
							: undefined
				)
			)(program)
	}
}
