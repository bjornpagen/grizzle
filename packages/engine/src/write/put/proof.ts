import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { NodeId, ParamId } from "#compiler/core/ids.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import {
	inputSetPlaceholder,
	keptRowsOf,
	type NodeOf,
	type RelNode,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, sameScalarType } from "#compiler/ir/scalar.ts"
import { only } from "#compiler/write/defined.ts"
import { unrefined } from "#compiler/write/insert/statement.ts"

/** The value one key field carries at some node: a column of the node, or a parameter or literal it equals. */
type KeyValue =
	| { readonly kind: "column"; readonly name: string }
	| { readonly kind: "constant"; readonly key: string }

/** The identity of a parameter or a literal expression, under which two of them denote the same value. */
const constantKey = (expr: ScalarExpr): string | undefined => {
	if (expr.kind === "param") {
		return `param:${expr.param}`
	}
	if (expr.kind === "literal") {
		return `literal:${canonicalTextOf({ value: expr.value, type: baseOf(expr.type).carrier })}`
	}
	return undefined
}

/** The value of output column `name` of a ProjectSet, in terms of its input. */
const projected = (node: NodeOf<"ProjectSet">, name: string): KeyValue | undefined => {
	const out = node.out.find((o) => o.name === name)
	if (out === undefined) {
		return undefined
	}
	const expr = out.expr
	if (expr.kind === "column" && expr.column.node === node.input.id) {
		return { kind: "column", name: expr.column.name }
	}
	const key = constantKey(expr)
	return key === undefined ? undefined : { kind: "constant", key }
}

/** The equivalence classes of a match region's variables under its equalities, each class its least-labelled variable. */
const varClasses = (node: NodeOf<"MatchRegion">): ((v: VarDecl) => VarDecl) => {
	const parent = new Map<VarDecl, VarDecl>()
	const find = (v: VarDecl): VarDecl => {
		let x = v
		for (let up = parent.get(x); up !== undefined && up !== x; up = parent.get(x)) {
			x = up
		}
		return x
	}
	for (const e of node.equalities) {
		const a = find(e.a)
		const b = find(e.b)
		if (a !== b) {
			parent.set(a.id < b.id ? b : a, a.id < b.id ? a : b)
		}
	}
	return find
}

/** Key values through a projection: a column's as the input column it copies, a constant as it is; undefined when a
 * column is computed. */
const throughProjection = (
	node: NodeOf<"ProjectSet">,
	values: ReadonlyMap<string, KeyValue>
): ReadonlyMap<string, KeyValue> | undefined => {
	const next = new Map<string, KeyValue>()
	for (const [field, v] of values) {
		const p = v.kind === "constant" ? v : projected(node, v.name)
		if (p === undefined) {
			return undefined
		}
		next.set(field, p)
	}
	return next
}

/** A node and the key values each of its rows must carry: one question of the existing-keys proof. */
interface KeyQuestion {
	readonly node: RelNode
	readonly values: ReadonlyMap<string, KeyValue>
}

/**
 * A question's identity over its node: each field, then its value's kind and its column's name or its constant's key,
 * so two questions over one node ask the same thing exactly when their identities are one tuple.
 */
const questionKey = (vs: ReadonlyMap<string, KeyValue>): ReadonlyArray<string> =>
	[...vs].flatMap(([field, v]) => [field, v.kind, v.kind === "column" ? v.name : v.key])

/**
 * Whether every row of `root` carries at the key fields the given values (one per primary key field of `relation`)
 * the key of a stored fact of `relation`.
 *
 * Each question is about one node and the values its rows must carry, and is answered from questions about the node's
 * inputs only, so the questions form a finite acyclic graph over the query DAG: the fold (ir/fold.ts) answers each
 * once, inputs first, its frames on the heap, whatever the DAG's depth. A node asked about with the same values twice,
 * by two arms of a union or two occurrences, is the one question, so no walk repeats.
 */
const provesKeys = (
	root: RelNode,
	relation: RelationInfo,
	values: ReadonlyMap<string, KeyValue>
): boolean => {
	const asked = new Map<RelNode, TupleMap<string, KeyQuestion>>()
	const question = (node: RelNode, vs: ReadonlyMap<string, KeyValue>): KeyQuestion => {
		const key = questionKey(vs)
		const byNode = asked.get(node) ?? new TupleMap<string, KeyQuestion>()
		asked.set(node, byNode)
		const known = byNode.get(key)
		if (known !== undefined) {
			return known
		}
		const fresh: KeyQuestion = { node, values: vs }
		byNode.set(key, fresh)
		return fresh
	}
	const answers = new Fold<KeyQuestion, boolean>(function* (q) {
		const node = q.node
		switch (node.kind) {
			case "Base":
				return (
					node.relation === relation.name &&
					node.relationKind === "relation" &&
					relation.primaryKey.every((f) => {
						const v = q.values.get(f)
						return v?.kind === "column" && v.name === f && node.heading.some((c) => c.name === f)
					})
				)
			case "ProjectSet": {
				const next = throughProjection(node, q.values)
				return next !== undefined && (yield question(node.input, next))
			}
			case "Union": {
				if (node.groups.length === 0) {
					return false
				}
				for (const g of node.groups) {
					for (const arm of g.arms) {
						if (!(yield question(arm, q.values))) {
							return false
						}
					}
				}
				return true
			}
			case "MatchRegion": {
				const classOf = varClasses(node)
				const correlated = new Set(node.correlated.map((c) => classOf(c.var)))
				/** Each key field's variable class, or the constant it equals. */
				const wanted = new Map<
					string,
					| { readonly kind: "class"; readonly cls: VarDecl }
					| { readonly kind: "constant"; readonly key: string }
				>()
				for (const [field, v] of q.values) {
					if (v.kind === "constant") {
						wanted.set(field, { kind: "constant", key: v.key })
						continue
					}
					const decl = node.vars.find((d) => d.name === v.name)
					if (decl === undefined || correlated.has(classOf(decl))) {
						return false
					}
					wanted.set(field, { kind: "class", cls: classOf(decl) })
				}
				for (const o of node.occurrences) {
					const next = new Map<string, KeyValue>()
					for (const [field, w] of wanted) {
						const column =
							w.kind === "class"
								? o.bindings.find((b) => classOf(b.var) === w.cls)?.column
								: o.constants.find((c) => constantKey(c.expr) === w.key)?.column
						if (column !== undefined) {
							next.set(field, { kind: "column", name: column })
						}
					}
					if (next.size === wanted.size && (yield question(o.source, next))) {
						return true
					}
				}
				return false
			}
			case "InputSet":
			case "Closed":
			case "Context":
			case "Delta":
			case "Filter":
			case "SemiJoin":
			case "AntiJoin":
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
			case "OrderedSetAggregate": {
				/** A kept row is its input's (`keptRowsOf`), and an intersection's row is its right side's too. */
				const kept = keptRowsOf(node)
				if (kept !== undefined && (yield question(kept.input, q.values))) {
					return true
				}
				return node.kind === "Intersect" && (yield question(node.right, q.values))
			}
		}
	})
	return answers.of(question(root, values))
}

/** Whether a member column keeps its value when the statement casts it into the field's type: the same base type and
 * typmod, a contract's or a refinement's domain only checking a value (`keyUniqueByEvidence`). */
const castKeeps = (node: RelNode, relation: RelationInfo, field: string): boolean => {
	const column = node.heading.find((c) => c.name === field)
	const target = relation.heading.find((c) => c.name === field)
	return (
		column !== undefined &&
		target !== undefined &&
		sameScalarType(unrefined(column.type), unrefined(target.type))
	)
}

/** Whether every row of the described member `id` carries the primary key of a stored fact of `relation`, so the put
 * reads only existing keys. The key columns must keep their values under the statement's cast, so the
 * UPDATE's key comparison is the comparison the proof is about.
 *
 * The structural proofs a put target needs beyond the relation's mutability.
 *
 * Two of the mutable put targets are admissible only with a proof about the members, read from the write DAG:
 *
 * - UPDATE ... FROM realizes "a described put that reads only existing keys of a mutable relation, such as counters
 *   and status moves". existingKeysProof proves that every row of a described member carries, at the
 *   relation's primary key, the key of a stored fact of that relation in the state the member is evaluated against:
 *   following the key columns down through projections, filters, matches and set operations, each must come from one
 *   occurrence of the relation's own Base, all key fields from the same occurrence. A key fixed by a parameter or a
 *   literal counts when the same occurrence fixes the same key field to the same parameter or literal, as the worked
 *   example's arm switch writes it. Then every member row updates a stored row or is identical to one, and no
 *   member row would be inserted, so the UPDATE realizes the put's insertion completely.
 * - MERGE realizes "puts mixed with deletes of absent keys over one mutable relation, a reread, when the deletion
 *   member is provably `R where <scope predicate> and key not in put input`". mergeScopeProof proves it:
 *   the deletion member is an anti-join whose left side is every complete fact of the relation's own Base occurrence
 *   under filters over its own columns (the scope predicate), whose join columns are exactly the primary key, and
 *   whose right side delivers exactly the keys the put input delivers: both read the same relation parameter at the
 *   same columns, unfiltered. Its NOT MATCHED BY SOURCE action then deletes exactly the deletion member's facts.
 *
 * Every proof is structural and conservative: a shape it does not recognize proves nothing, and the put falls back to
 * the DELETE-then-insert pair, which is always admissible. */
export const existingKeysProof = (node: RelNode, relation: RelationInfo): boolean => {
	if (!relation.primaryKey.every((f) => castKeeps(node, relation, f))) {
		return false
	}
	return provesKeys(
		node,
		relation,
		new Map(relation.primaryKey.map((f) => [f, { kind: "column", name: f } as const]))
	)
}

/** The scope of a proved MERGE deletion: the scope predicate is the conjunction of `predicates` and of each field in
 * `constants` equal to its expression, every column the expressions read being a column of one of the nodes `nodes`
 * names that `fieldOf` maps to a field of the relation. */
export interface MergeScope {
	/** The labels of the match region over the relation and the filters above it, whose columns the predicates read. */
	readonly nodes: ReadonlyArray<NodeId>
	/** Column name (in every node of `nodes`) to the relation's field. */
	readonly fieldOf: ReadonlyMap<string, string>
	readonly predicates: ReadonlyArray<ScalarExpr>
	readonly constants: ReadonlyArray<{ readonly field: string; readonly expr: ScalarExpr }>
}

/** Each variable of a match region's one occurrence to the column it binds, and the bound columns, when no variable or
 * column is bound twice. */
const bindingFields = (
	occurrence: NodeOf<"MatchRegion">["occurrences"][number]
):
	| { readonly fieldOf: ReadonlyMap<string, string>; readonly bound: ReadonlySet<string> }
	| undefined => {
	const fieldOf = new Map<string, string>()
	const bound = new Set<string>()
	for (const b of occurrence.bindings) {
		if (fieldOf.has(b.var.name) || bound.has(b.column)) {
			return undefined
		}
		fieldOf.set(b.var.name, b.column)
		bound.add(b.column)
	}
	return { fieldOf, bound }
}

/**
 * The scope of a proved MERGE deletion at the region a chain of projections and filters ends in (scopedFacts): its
 * one occurrence scans the relation's own Base, every field of the relation is the column its projection says, bound
 * in the occurrence, or the constant the occurrence fixes it to, and every predicate reads only the region's columns,
 * through the region or a filter above it.
 */
const regionScope = (
	node: NodeOf<"MatchRegion">,
	relation: RelationInfo,
	columns: ReadonlyMap<string, KeyValue>,
	predicates: ReadonlyArray<ScalarExpr>,
	nodes: ReadonlyArray<NodeId>
): MergeScope | undefined => {
	const occurrence = only(node.occurrences)
	if (occurrence === undefined || node.equalities.length > 0 || node.correlated.length > 0) {
		return undefined
	}
	const base = occurrence.source
	if (base.kind !== "Base" || base.relation !== relation.name || base.relationKind !== "relation") {
		return undefined
	}
	const bindings = bindingFields(occurrence)
	if (bindings === undefined) {
		return undefined
	}
	const { fieldOf, bound } = bindings
	/** Whether the occurrence fixes `field` to the parameter or literal `key`. */
	const fixedTo = (field: string, key: string): boolean => {
		const fixed = occurrence.constants.find((c) => c.column === field)
		return fixed !== undefined && constantKey(fixed.expr) === key
	}
	const held = [...columns].every(([field, v]) =>
		v.kind === "column" ? fieldOf.get(v.name) === field : fixedTo(field, v.key)
	)
	if (occurrence.constants.some((c) => bound.has(c.column)) || !held) {
		return undefined
	}
	const scope = [...nodes, node.id]
	const scopeNodes = new Set(scope)
	const outside =
		predicates.some((p) => p.deps.nodes.some((n) => !scopeNodes.has(n))) ||
		occurrence.constants.some((c) => c.expr.deps.nodes.length > 0)
	if (outside) {
		return undefined
	}
	return {
		nodes: scope,
		fieldOf,
		predicates,
		constants: occurrence.constants.map((c) => ({ field: c.column, expr: c.expr }))
	}
}

/** The facts of a node as "every fact of the relation's Base under filters over its own columns", if they are.
 * `fields` maps each field of the relation to the node's column carrying it, or to the parameter or literal the
 * field equals throughout, which the occurrence must fix it to (a constant among the match's bindings).
 *
 * The walk descends the chain of projections and filters above the region, one input at a time, so it visits each
 * node once and ends at the first node that is neither; that node must be the region (regionScope). Any other node is
 * no scope this proof recognizes. */
const scopedFacts = (
	start: RelNode,
	relation: RelationInfo,
	fields: ReadonlyMap<string, KeyValue>
): MergeScope | undefined => {
	let node = start
	let columns = fields
	const predicates: Array<ScalarExpr> = []
	const nodes: Array<NodeId> = []
	while (node.kind === "ProjectSet" || node.kind === "Filter") {
		if (node.kind === "Filter") {
			predicates.push(node.pred)
			nodes.push(node.id)
		} else {
			const next = throughProjection(node, columns)
			if (next === undefined) {
				return undefined
			}
			columns = next
		}
		node = node.input
	}
	return node.kind === "MatchRegion"
		? regionScope(node, relation, columns, predicates, nodes)
		: undefined
}

/** The key set a node delivers at `columns`, when it is exactly the projection of one InputSet placeholder's columns,
 * unfiltered: the same placeholder and columns mean the same set of key tuples (sameKeySet), so two InputSets over one
 * placeholder read one fact set. */
interface KeySetIdentity {
	readonly param: ParamId
	readonly columns: ReadonlyArray<string>
}

const sameKeySet = (a: KeySetIdentity, b: KeySetIdentity): boolean =>
	a.param === b.param &&
	a.columns.length === b.columns.length &&
	a.columns.every((c, i) => c === b.columns[i])

/** One step of the key-set walk: the identity found (or none), or the columns of the next node to read. */
type KeySetStep =
	| { readonly kind: "found"; readonly identity: KeySetIdentity | undefined }
	| { readonly kind: "next"; readonly node: RelNode; readonly columns: ReadonlyArray<string> }

const noKeySet: KeySetStep = { kind: "found", identity: undefined }

/** A node's step: an InputSet ends the walk, a projection or a one-occurrence region reads its input's columns. */
const keySetStep = (node: RelNode, columns: ReadonlyArray<string>): KeySetStep => {
	switch (node.kind) {
		case "InputSet":
			return {
				kind: "found",
				identity:
					node.input.kind !== "row" && columns.every((c) => node.heading.some((h) => h.name === c))
						? { param: inputSetPlaceholder(node.input), columns }
						: undefined
			}
		case "ProjectSet": {
			const next: Array<string> = []
			for (const c of columns) {
				const p = projected(node, c)
				if (p?.kind !== "column") {
					return noKeySet
				}
				next.push(p.name)
			}
			return { kind: "next", node: node.input, columns: next }
		}
		case "MatchRegion": {
			const occurrence = only(node.occurrences)
			if (occurrence === undefined || node.equalities.length > 0 || node.correlated.length > 0) {
				return noKeySet
			}
			if (occurrence.constants.length > 0) {
				return noKeySet
			}
			const next: Array<string> = []
			for (const c of columns) {
				const decl = node.vars.find((d) => d.name === c)
				const binding =
					decl === undefined ? undefined : occurrence.bindings.find((b) => b.var === decl)
				if (binding === undefined) {
					return noKeySet
				}
				next.push(binding.column)
			}
			return { kind: "next", node: occurrence.source, columns: next }
		}
		case "Base":
		case "Closed":
		case "Context":
		case "Delta":
		case "Filter":
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
			return noKeySet
	}
}

/**
 * The key set `start` delivers at `columns`, when it is one (KeySetIdentity). Each step reads one input of the node
 * before (a projection's input, a region's one source), so the walk descends the DAG, which is finite and acyclic,
 * visiting each node at most once, and ends at an InputSet or at the first node no step reads through. Any other node
 * is no key set this proof recognizes.
 */
const keySetIdentity = (
	start: RelNode,
	startColumns: ReadonlyArray<string>
): KeySetIdentity | undefined => {
	let step = keySetStep(start, startColumns)
	while (step.kind === "next") {
		step = keySetStep(step.node, step.columns)
	}
	return step.identity
}

/** Whether the deletion member `deletion` is provably `relation where <scope> and key not in <put input>` for the put
 * member `put`, and its scope when it is. */
export const mergeScopeProof = (
	anti: RelNode,
	put: RelNode,
	relation: RelationInfo
): MergeScope | undefined => {
	if (anti.kind !== "AntiJoin") {
		return undefined
	}
	const pk = relation.primaryKey
	if (!pk.every((f) => castKeeps(put, relation, f))) {
		return undefined
	}
	/** The anti-join compares exactly the primary key: each key field in one pair, and no other pair. */
	const pairs: Array<(typeof anti.on)[number]> = []
	for (const f of pk) {
		const pair = only(anti.on.filter((p) => p.left === f))
		if (pair === undefined) {
			return undefined
		}
		pairs.push(pair)
	}
	if (anti.on.length !== pk.length) {
		return undefined
	}
	const fields = relation.heading.map((c) => c.name)
	const left = anti.left
	if (left.heading.length !== fields.length) {
		return undefined
	}
	if (
		!fields.every(
			(f) => left.heading.some((c) => c.name === f) && anti.heading.some((c) => c.name === f)
		)
	) {
		return undefined
	}
	const scope = scopedFacts(
		anti.left,
		relation,
		new Map(fields.map((f) => [f, { kind: "column", name: f } as const]))
	)
	if (scope === undefined) {
		return undefined
	}
	const right = keySetIdentity(
		anti.right,
		pairs.map((p) => p.right)
	)
	const input = keySetIdentity(put, pk)
	return right !== undefined && input !== undefined && sameKeySet(right, input) ? scope : undefined
}
