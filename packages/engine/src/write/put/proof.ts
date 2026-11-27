import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { type PropsUnder, propsUnder, unplaced } from "#compiler/analysis/physical/analyze.ts"
import type { FixedFacts } from "#compiler/analysis/physical/props.ts"
import type { NodeId, VarId } from "#compiler/core/ids.ts"
import { once } from "#compiler/core/lazy.ts"
import { fieldReads, type ScalarExpr } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import { keptRowsOf, type NodeOf, type RelNode, regionVarClasses } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { fixedEqual, type FixedName, fixedNameKey, valueAt } from "#compiler/logical/props.ts"
import { unrefined } from "#compiler/write/insert/statement.ts"

/**
 * The value one key field carries at some node: a column of the node, or the value a name holds throughout, a
 * parameter, a literal or an outer column (logical/props.ts FixedName, the identity a fixed column's value has).
 */
type KeyValue =
	| { readonly kind: "column"; readonly name: string }
	| { readonly kind: "named"; readonly name: FixedName }

/** The name an expression a node evaluates over the input `input` holds throughout, where it holds one (valueAt). */
const namedAt = (expr: ScalarExpr, input: ReadonlySet<NodeId>): FixedName | undefined => {
	const value = valueAt(expr, input)
	return value.kind === "local" || value.kind === "expr" ? undefined : value
}

/** Each node's columns fixed per evaluation, as the physical analysis proves them (analysis/physical/props.ts fixed). */
type FixedColumns = (node: RelNode) => ReadonlyMap<string, FixedFacts>

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
	const held = namedAt(expr, new Set([node.input.id]))
	return held === undefined ? undefined : { kind: "named", name: held }
}

/** Key values through a projection: a column's as the input column it copies, a name's as it is; undefined when a
 * column is computed. */
const throughProjection = (
	node: NodeOf<"ProjectSet">,
	values: ReadonlyMap<string, KeyValue>
): ReadonlyMap<string, KeyValue> | undefined => {
	const next = new Map<string, KeyValue>()
	for (const [field, v] of values) {
		const p = v.kind === "named" ? v : projected(node, v.name)
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
 * A question's identity over its node: each field, then its value's kind and its column's name or its name's identity
 * (fixedNameKey), so two questions over one node ask the same thing exactly when their identities are one tuple.
 */
const questionKey = (vs: ReadonlyMap<string, KeyValue>): ReadonlyArray<string> =>
	[...vs].flatMap(([field, v]) => [
		field,
		v.kind,
		v.kind === "column" ? v.name : fixedNameKey(v.name)
	])

/**
 * Key values at `node` with each name a column of the node holds throughout read as that column: the column `fixed`
 * proves fixed to the name (fixedEqual), the first of the node's heading that is. A field every row carries the name at,
 * where a column of every row holds the name too, carries that column's value, so the question is the same question.
 */
const asFixedColumns = (
	node: RelNode,
	values: ReadonlyMap<string, KeyValue>,
	fixed: FixedColumns
): ReadonlyMap<string, KeyValue> => {
	if (![...values.values()].some((v) => v.kind === "named")) {
		return values
	}
	const facts = fixed(node)
	const columnOf = (name: FixedName): string | undefined =>
		node.heading.find((c) => facts.get(c.name)?.some((f) => fixedEqual(f.fixed, name)) ?? false)
			?.name
	return new Map(
		[...values].map(([field, v]): readonly [string, KeyValue] => {
			const column = v.kind === "named" ? columnOf(v.name) : undefined
			return [field, column === undefined ? v : { kind: "column", name: column }]
		})
	)
}

/**
 * Whether every row of `root` carries at the given fields the values (`values`, one per field `keyedBy` names) of one
 * stored fact of `relation`, so its key is that fact's.
 *
 * Each question is about one node and the values its rows must carry, and is answered from questions about the node's
 * inputs only, so the questions form a finite acyclic graph over the query DAG: the fold (ir/fold.ts) answers each
 * once, inputs first, its frames on the heap, whatever the DAG's depth. A node asked about with the same values twice,
 * by two arms of a union or two occurrences, is the one question, so no walk repeats.
 */
const provesKeys = (
	root: RelNode,
	relation: RelationInfo,
	values: ReadonlyMap<string, KeyValue>,
	fixed: FixedColumns
): boolean => {
	const asked = new Map<RelNode, TupleMap<ReadonlyArray<string>, KeyQuestion>>()
	const question = (node: RelNode, vs: ReadonlyMap<string, KeyValue>): KeyQuestion => {
		const key = questionKey(vs)
		const byNode = asked.getOrInsertComputed(
			node,
			() => new TupleMap<ReadonlyArray<string>, KeyQuestion>()
		)
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
		const keyed = asFixedColumns(node, q.values, fixed)
		switch (node.kind) {
			case "Base":
				return (
					node.relation === relation.name &&
					node.relationKind === "relation" &&
					[...keyed].every(
						([f, v]) =>
							v.kind === "column" && v.name === f && node.heading.some((c) => c.name === f)
					)
				)
			case "ProjectSet": {
				const next = throughProjection(node, keyed)
				return next !== undefined && (yield question(node.input, next))
			}
			case "Step":
				return yield question(node.input, keyed)
			case "Union": {
				if (node.groups.length === 0) {
					return false
				}
				for (const g of node.groups) {
					for (const arm of g.arms) {
						if (!(yield question(arm, keyed))) {
							return false
						}
					}
				}
				return true
			}
			case "MatchRegion": {
				const classOf = regionVarClasses(node)
				const correlated = new Set(node.correlated.map((c) => classOf(c.var)))
				const locals = new Set([node.id])
				/**
				 * Each key field's variable class with the name of the region's column the question reads it at, as an
				 * occurrence correlated to the region reads it (an outer column), or the name whose value the field carries.
				 * An occurrence carries a key field at the column it binds the field's variable at, or at the column it fixes
				 * to the field's name; any other field its source's rows must carry, the same question asked there of the name
				 * it holds: a variable's as the outer column a step that reads the region fixes its column to, a name as the
				 * column a step's filter fixes to it (asFixedColumns).
				 */
				const wanted = new Map<
					string,
					| { readonly kind: "class"; readonly cls: VarId; readonly outer: FixedName }
					| { readonly kind: "named"; readonly name: FixedName }
				>()
				for (const [field, v] of keyed) {
					if (v.kind === "named") {
						wanted.set(field, v)
						continue
					}
					const decl = node.vars.find((d) => d.name === v.name)
					if (decl === undefined || correlated.has(classOf(decl))) {
						return false
					}
					wanted.set(field, {
						kind: "class",
						cls: classOf(decl),
						outer: { kind: "outer", node: node.id, column: v.name }
					})
				}
				for (const o of node.occurrences) {
					const next = new Map<string, KeyValue>()
					for (const [field, w] of wanted) {
						const name = w.kind === "class" ? w.outer : w.name
						const column =
							(w.kind === "class"
								? o.bindings.find((b) => classOf(b.var) === w.cls)?.column
								: undefined) ??
							o.constants.find((c) => {
								const held = namedAt(c.expr, locals)
								return held !== undefined && fixedEqual(held, name)
							})?.column
						next.set(
							field,
							column === undefined ? { kind: "named", name } : { kind: "column", name: column }
						)
					}
					if (yield question(o.source, next)) {
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
			case "OrderedSetAggregate":
			case "Call": {
				/** A kept row is its input's (`keptRowsOf`), and an intersection's row is its right side's too. */
				const kept = keptRowsOf(node)
				if (kept !== undefined && (yield question(kept.input, keyed))) {
					return true
				}
				return node.kind === "Intersect" && (yield question(node.right, keyed))
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

/** Whether every row of a described member carries the primary key of a stored fact of `relation`, so the put reads
 * only existing keys, over the physical analysis of `schema`'s templates (existingKeysProofOver). The key columns must
 * keep their values under the statement's cast, so the UPDATE's key comparison is the comparison the proof is about.
 *
 * The structural proofs a put target needs beyond the relation's mutability.
 *
 * One of the mutable put targets is admissible only with a proof about the members, read from the write DAG:
 *
 * - UPDATE ... FROM realizes "a described put that reads only existing keys of a mutable relation, such as counters
 *   and status moves". existingKeysProof proves that every row of a described member carries, at the
 *   relation's primary key, the key of a stored fact of that relation in the state the member is evaluated against:
 *   following the key columns down through projections, filters, a navigation's steps, matches and set operations,
 *   each must come from one occurrence of the relation's own Base, all key fields from the same occurrence. A key fixed
 *   to a parameter, a literal or an outer column counts when the same occurrence fixes the same key field to it, as the
 *   worked example's arm switch writes it, or when a column of the occurrence's source is fixed to it, the column the
 *   occurrence binds the key field at: a key bound at a parameter, which a navigation's step reads through a filter
 *   (`__key = $key`). A column fixed to a value is the one fact the physical analysis proves of it (analysis/physical
 *   props.ts PhysicalProps fixed, which a shared node's key set reads too), each node's computed where the proof first
 *   asks of it. Then every member row updates a stored row or is identical to one, and no member row would be
 *   inserted, so the UPDATE realizes the put's insertion completely.
 *
 * Every proof is structural and conservative: a shape it does not recognize proves nothing, and the put falls back to
 * the DELETE-then-insert pair, which is always admissible. */
export const existingKeysProofOver = (
	schema: CatalogSchema
): ((node: RelNode, relation: RelationInfo) => boolean) => {
	const physical = once((): PropsUnder =>
		propsUnder({
			context: "transaction",
			catalog: evidenceCatalog(schema),
			realization: unplaced,
			roots: "ignored"
		})
	)
	const fixed: FixedColumns = (node) => physical().of(node).fixed
	return (node, relation) => {
		const fields = keyedBy(node, relation)
		return (
			fields.every((f) => castKeeps(node, relation, f)) &&
			provesKeys(
				node,
				relation,
				new Map(fields.map((f) => [f, { kind: "column", name: f } as const])),
				fixed
			)
		)
	}
}

/**
 * The fields a member's rows carry the key of `relation` by: each primary key field the member delivers, and for a key
 * generation it leaves out (ir/law.ts FieldWriting keyGenerated), which its statement computes over the fields it
 * reads (insert/input.ts keyGeneratedRead), those fields, since rows equal at them are equal at the generation, which
 * the key's CHECK holds every stored fact to. Each field once, in key order.
 */
const keyedBy = (node: RelNode, relation: RelationInfo): ReadonlyArray<string> => [
	...new Set(
		relation.primaryFields.flatMap((f) =>
			f.writing.kind === "keyGenerated" && !node.heading.some((c) => c.name === f.name)
				? fieldReads([f.writing.expr])
				: [f.name]
		)
	)
]
