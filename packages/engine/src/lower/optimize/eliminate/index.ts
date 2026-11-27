import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { containmentEvidence } from "#compiler/analysis/physical/evidence.ts"
import type { JustifiedKey } from "#compiler/analysis/physical/fds.ts"
import { keyAmong } from "#compiler/analysis/physical/props.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { OccurrenceId } from "#compiler/core/ids.ts"
import {
	type EvidenceContext,
	type ExistenceConstraint,
	type Grounds,
	type Premise,
	strongest,
	type TemplateContext
} from "#compiler/ir/evidence.ts"
import type { OpId, ScalarExpr } from "#compiler/ir/expr.ts"
import type {
	Cell,
	EditRefs,
	KeySet,
	KindOver,
	OccurrenceOver,
	RootedDag,
	VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type CellPhysical,
	overPhysical,
	type Potential,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { carrierEquality } from "#compiler/scalar/compute/registry.ts"

const eliminationRule = "R03.elimination"
const keyJoinRule = "R03.keyJoin"
const containedEqualityRule = "R03.containedEquality"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>
type Base = KindOver<"Base", EditRefs>

interface Elimination {
	readonly occurrence: Occurrence
	readonly via: Occurrence
	readonly containment: ExistenceConstraint
	readonly key: JustifiedKey
	/** The containment's premises: its constraint's, or none when its roster's domain enforces it. */
	readonly existence: ReadonlyArray<Premise>
	readonly existenceContext: EvidenceContext
}

/**
 * A way stored occurrence `o`, scanning `s`, may be removed through occurrence `t`, scanning `tb`, as the cells and the
 * catalog say: a containment from `tb`'s fields to `s`'s that `t` binds to every variable `o` binds, over every field
 * of `s` it names. Its proof is a key of `s` among those fields and the containment's evidence (eliminationProof).
 */
interface EliminationWay {
	readonly occurrence: Occurrence
	readonly via: Occurrence
	readonly containment: ExistenceConstraint
}

/**
 * Whether occurrence `o` binds each of a containment's target fields to the variable occurrence `t` binds the matching
 * source field to, `same` telling two variables one: every binding `o` makes at a target field, and at least one at
 * each. Each row of `t` then meets `o`'s rows at the containment's fields alone, which exactlyOne proves one row.
 */
export const boundThrough = <V>(
	containment: ExistenceConstraint,
	o: { readonly bindings: ReadonlyArray<{ readonly column: string; readonly var: V }> },
	t: { readonly bindings: ReadonlyArray<{ readonly column: string; readonly var: V }> },
	same: (a: V, b: V) => boolean
): boolean =>
	containment.from.fields.length === containment.to.fields.length &&
	containment.to.fields.every((field, i) => {
		const at = o.bindings.filter((b) => b.column === field)
		return (
			at.length > 0 &&
			at.every((b) =>
				t.bindings.some((x) => x.column === containment.from.fields[i] && same(x.var, b.var))
			)
		)
	})

/**
 * The proof that each row of a containment's source meets exactly one row of its target at the containment's fields: a
 * key of the target among them (`key`, at most one) and the containment's evidence in the context (at least one).
 * R03.elimination removes an occurrence so met that nothing else reads; a page's window driver reads one per driver row
 * (lower/shapes/page/driver.ts).
 */
export const exactlyOne = <K>(
	containment: ExistenceConstraint,
	key: K | undefined,
	context: TemplateContext
): { readonly key: K; readonly existence: Grounds } | undefined => {
	if (key === undefined) {
		return undefined
	}
	const existence = containmentEvidence(containment, context)
	return existence === undefined ? undefined : { key, existence }
}

/** Each way `o`, scanning `s`, may be removed through `t`, scanning `tb` (EliminationWay), in the catalog's order. */
const waysVia = (
	cx: RewriteCx,
	o: Occurrence,
	s: Base,
	t: Occurrence,
	tb: Base
): ReadonlyArray<EliminationWay> =>
	cx.catalog.containments.flatMap((c) =>
		c.from.relation !== tb.relation ||
		c.to.relation !== s.relation ||
		!boundThrough(c, o, t, (a, b) => a.id === b.id) ||
		!o.bindings.every((b) => c.to.fields.includes(b.column))
			? []
			: [{ occurrence: o, via: t, containment: c }]
	)

/**
 * Each way a stored occurrence of a region may be removed through another stored occurrence of it, as the cells and
 * the catalog say, in occurrence order, then the other occurrence's, then the catalog's: none on a recursion's feedback
 * or in a region of one occurrence.
 */
const eliminationWays = (
	cx: RewriteCx,
	cell: Cell,
	region: Region
): ReadonlyArray<EliminationWay> => {
	if (region.occurrences.length < 2 || cx.cells.feedback.has(cell)) {
		return []
	}
	return region.occurrences.flatMap((o) => {
		const s = o.source.current
		if (
			s.kind !== "Base" ||
			s.relationKind !== "relation" ||
			o.constants.length > 0 ||
			o.bindings.length === 0
		) {
			return []
		}
		return region.occurrences.flatMap((t) => {
			const tb = t.source.current
			return t.id === o.id || tb.kind !== "Base" || tb.relationKind !== "relation"
				? []
				: waysVia(cx, o, s, t, tb)
		})
	})
}

/**
 * The proof of a way (EliminationWay): a key of the removed occurrence's relation among the containment's target
 * fields, under `physical`, and the containment holding in the context.
 */
const eliminationProof = (
	cx: RewriteCx,
	physical: CellPhysical,
	way: EliminationWay
): Elimination | undefined => {
	const one = exactlyOne(
		way.containment,
		keyAmong(physical.props(way.occurrence.source), way.containment.to.fields),
		cx.ctx.evidenceContext
	)
	return one === undefined
		? undefined
		: {
				occurrence: way.occurrence,
				via: way.via,
				containment: way.containment,
				key: one.key,
				existence: one.existence.premises,
				existenceContext: one.existence.context
			}
}

/** The first way of `ways` its proof holds for (eliminationProof), in their order, with its proof. */
const firstProof = (
	cx: RewriteCx,
	physical: CellPhysical,
	ways: ReadonlyArray<EliminationWay>
): Elimination | undefined => {
	for (const way of ways) {
		const proved = eliminationProof(cx, physical, way)
		if (proved !== undefined) {
			return proved
		}
	}
	return undefined
}

/** The native equality operators of the variables `bindings` bind, which a proof matching them compares under. */
const equalityOf = (bindings: Occurrence["bindings"]): ReadonlyArray<OpId> =>
	bindings.map((b) => carrierEquality(baseOf(b.var.type).carrier))

/**
 * Two occurrences of one stored relation that bind every column of one of its keys to one variable each: one fact of
 * the relation, so one occurrence carrying the bindings and constants of both delivers the region's rows, each as often
 * (`keyJoined`). `kept` is the earlier in occurrence order, `folded` the one it absorbs.
 */
interface KeyJoin<K> {
	readonly kept: Occurrence
	readonly folded: Occurrence
	readonly key: K
}

/** Whether two occurrences bind `column` to one variable. */
const sameVariable = (a: Occurrence, b: Occurrence, column: string): boolean =>
	a.bindings.some(
		(x) =>
			x.column === column && b.bindings.some((y) => y.column === column && y.var.id === x.var.id)
	)

/** Whether two of `occurrences` scan one stored relation: the pairs a key join may fold (keyJoinOf). */
const twoScansOfOne = (occurrences: ReadonlyArray<Occurrence>): boolean => {
	const seen = new Set<string>()
	for (const o of occurrences) {
		const s = o.source.current
		if (s.kind !== "Base" || s.relationKind !== "relation") {
			continue
		}
		if (seen.has(s.relation)) {
			return true
		}
		seen.add(s.relation)
	}
	return false
}

/**
 * The first key join of a region (KeyJoin), in occurrence order: two occurrences `admits` lets fold, over one stored
 * relation, where the columns both bind to one variable hold a key of it (`keyOf`, the one key among those columns).
 */
const keyJoinOf = <K extends { readonly columns: KeySet }>(
	region: Region,
	keyOf: (o: Occurrence, source: Base, shared: ReadonlySet<string>) => K | undefined,
	admits: (o: Occurrence) => boolean
): KeyJoin<K> | undefined => {
	const stored = region.occurrences.flatMap((o) => {
		const s = o.source.current
		return s.kind === "Base" && s.relationKind === "relation" && admits(o) ? [{ o, s }] : []
	})
	for (const [i, a] of stored.entries()) {
		for (const b of stored.slice(i + 1)) {
			if (a.s.relation !== b.s.relation) {
				continue
			}
			const shared = new Set(
				a.s.heading.flatMap((c) => (sameVariable(a.o, b.o, c.name) ? [c.name] : []))
			)
			const key = keyOf(a.o, a.s, shared)
			if (key !== undefined) {
				return { kept: a.o, folded: b.o, key }
			}
		}
	}
	return undefined
}

/**
 * The region a key join leaves: the folded occurrence gone, the kept one carrying its bindings and constants besides its
 * own, a binding both make once. A column the two bind to different variables is bound to both, which equates them.
 */
const keyJoined = <K>(region: Region, join: KeyJoin<K>): Region => {
	const { kept, folded } = join
	const merged: Occurrence = {
		...kept,
		bindings: [
			...kept.bindings,
			...folded.bindings.filter(
				(b) => !kept.bindings.some((x) => x.column === b.column && x.var.id === b.var.id)
			)
		],
		constants: [
			...kept.constants,
			...folded.constants.filter(
				(c) => !kept.constants.some((x) => x.column === c.column && x.expr.id === c.expr.id)
			)
		]
	}
	return {
		...region,
		occurrences: region.occurrences.flatMap((o) =>
			o.id === folded.id ? [] : o.id === kept.id ? [merged] : [o]
		)
	}
}

/**
 * The key-join rule (R03.keyJoin): two occurrences of a stored relation S bound to one variable at every column of a
 * physical key of S are one fact of S, so the later is folded into the earlier (`keyJoined`). The region's set and
 * multiplicity are unchanged: the key admits one fact per value, so the two scans pair each fact with itself alone. The
 * certificate carries the key's premises and the context its evidence requires.
 */
const keyJoinFold: Rule = {
	name: keyJoinRule,
	/** The region's set is unchanged, so its metadata stands. */
	at: (cell, cx) => {
		const node = cell.current
		if (
			node.kind !== "MatchRegion" ||
			node.occurrences.length < 2 ||
			cx.cells.feedback.has(cell) ||
			!twoScansOfOne(node.occurrences)
		) {
			return false
		}
		const admits = (o: Occurrence) => !cx.cells.lateral(o.source)
		if (!twoScansOfOne(node.occurrences.filter(admits))) {
			return false
		}
		return overPhysical(({ physical }) => {
			const join = keyJoinOf(
				node,
				(o, _source, shared) => keyAmong(physical.props(o.source), shared),
				admits
			)
			if (join === undefined) {
				return false
			}
			cx.certify({
				rule: keyJoinRule,
				inputs: [join.folded.source.id, join.kept.source.id, cell.id],
				outputs: [cell.id],
				premises: join.key.just.premises,
				context: join.key.just.context,
				preservedHeading: node.heading.map((c) => c.name),
				equality: equalityOf(join.kept.bindings.filter((b) => join.key.columns.includes(b.column))),
				coercion: join.key.just.coercions,
				params: undefined
			})
			cx.editor.set(cell, keyJoined(node, join))
			return true
		})
	}
}

/**
 * A query's checked DAG with every key join folded (`keyJoined`), by the keys its stored relations declare: what the
 * access extraction reads of a query (program/workload/compile.ts), whose optimized lowering folds each one by the key
 * the physical analysis proves of the same declaration (the key-join rule), so the extraction plans the probe of the one
 * scan the lowered statement makes, binding what both occurrences bind.
 */
export const keyJoinNormalDag = (dag: RootedDag): Result.Result<RootedDag, CompileError> =>
	catchRefusal(() => {
		const editor = new DagEditor(dag)
		const cells = editor.cellState()
		const folded = (region: Region): Region => {
			const join = keyJoinOf(
				region,
				(_o, s, shared) =>
					[s.primaryKey, ...s.keys]
						.map((columns) => ({ columns }))
						.find((k) => k.columns.every((c) => shared.has(c))),
				(o) => !cells.lateral(o.source)
			)
			return join === undefined ? region : folded(keyJoined(region, join))
		}
		for (const cell of editor.topoOrder()) {
			const node = cell.current
			if (node.kind === "MatchRegion") {
				const next = folded(node)
				if (next !== node) {
					editor.set(cell, next)
				}
			}
		}
		return editor.version === 0 ? dag : editor.finish()
	})

const eliminateRule: Rule = {
	name: eliminationRule,
	/** The region's set is unchanged, so its metadata stands. */
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "MatchRegion") {
			return false
		}
		const ways = eliminationWays(cx, cell, node)
		if (ways.length === 0) {
			return false
		}
		const open = ways.filter((w) => !cx.cells.lateral(w.occurrence.source))
		if (open.length === 0) {
			return false
		}
		return overPhysical(({ physical }) => {
			const e = firstProof(cx, physical, open)
			if (e === undefined) {
				return false
			}
			cx.certify({
				rule: eliminationRule,
				inputs: [e.occurrence.source.id, e.via.source.id, cell.id],
				outputs: [cell.id],
				premises: [...e.key.just.premises, ...e.existence],
				context: strongest([e.key.just.context, e.existenceContext]),
				preservedHeading: node.heading.map((c) => c.name),
				equality: equalityOf(e.occurrence.bindings),
				coercion: [],
				params: undefined
			})
			cx.editor.set(cell, {
				...node,
				occurrences: node.occurrences.filter((o) => o.id !== e.occurrence.id)
			})
			return true
		})
	}
}

/**
 * The equalities a containment and a key owe a region (R03.containedEquality): occurrences `from` of R and `to` of S, a
 * containment R(c) -> S(d) admitted in the context, and a key of S among the fields d_j that `to` binds to the variable
 * `from` binds at c_j (`matched`). Each row of the region pairs a fact of R with the one fact of S its c names, so c_i =
 * d_i at every other pair: each pair where neither binds the two to one variable and neither side fixes its field is owed
 * (`owed`).
 */
interface ContainedEquality {
	readonly from: Occurrence
	readonly to: Occurrence
	readonly matched: ReadonlyArray<VarDecl>
	readonly key: JustifiedKey
	readonly existence: Grounds
	readonly owed: NonEmptyReadonlyArray<OwedEquality>
}

/** A field of an occurrence, and the variable it binds the field to, none where it binds none. */
interface FieldSide {
	readonly occurrence: OccurrenceId
	readonly column: string
	readonly var: VarDecl | undefined
}

/**
 * An equality a containment owes (ContainedEquality `owed`): two fields, one of `from` and its pair of `to`, at most one
 * bound to a variable, neither fixed.
 */
interface OwedEquality {
	readonly from: FieldSide
	readonly to: FieldSide
}

/** The variable `o` binds `column` to, its first binding of it; none where it binds none. */
const boundAt = (o: Occurrence, column: string): VarDecl | undefined =>
	o.bindings.find((b) => b.column === column)?.var

/** Whether `o` fixes `column` to a constant. */
const fixedAt = (o: Occurrence, column: string): boolean =>
	o.constants.some((c) => c.column === column)

/** The equalities containment `c` owes `from` and `to` at the pairs `matched` leaves (ContainedEquality `owed`). */
const owedBy = (
	c: ExistenceConstraint,
	from: Occurrence,
	to: Occurrence,
	matched: ReadonlySet<number>
): ReadonlyArray<OwedEquality> =>
	c.from.fields.flatMap((field, i) => {
		const target = defined(c.to.fields[i], "a containment pairs its fields one for one")
		const atFrom = boundAt(from, field)
		const atTo = boundAt(to, target)
		return matched.has(i) ||
			fixedAt(from, field) ||
			fixedAt(to, target) ||
			(atFrom !== undefined && atTo !== undefined)
			? []
			: [
					{
						from: { occurrence: from.id, column: field, var: atFrom },
						to: { occurrence: to.id, column: target, var: atTo }
					}
				]
	})

/**
 * The first equality a containment and a key owe `region` (ContainedEquality), in occurrence order, then the other
 * occurrence's, then the catalog's: occurrences of two relations read by their tables, a containment of the first's in
 * the second's the catalog states,
 * the pairs both bind to one variable holding a key of the second under `physical`, the containment admitted in the
 * context, and an equality owed.
 */
const containedEqualityOf = (
	cx: RewriteCx,
	physical: CellPhysical,
	region: Region
): ContainedEquality | undefined => {
	for (const from of region.occurrences) {
		const r = from.source.current
		if (r.kind !== "Base") {
			continue
		}
		for (const to of region.occurrences) {
			const s = to.source.current
			if (to.id === from.id || s.kind !== "Base") {
				continue
			}
			for (const c of cx.catalog.containments) {
				if (
					c.from.relation !== r.relation ||
					c.to.relation !== s.relation ||
					c.from.fields.length !== c.to.fields.length
				) {
					continue
				}
				const pairs = c.from.fields.flatMap((field, i) => {
					const v = boundAt(from, field)
					const target = defined(c.to.fields[i], "a containment pairs its fields one for one")
					return v !== undefined &&
						to.bindings.some((b) => b.column === target && b.var.id === v.id)
						? [{ i, target, v }]
						: []
				})
				const owed = owedBy(c, from, to, new Set(pairs.map((p) => p.i)))
				if (!isNonEmpty(owed)) {
					continue
				}
				const one = exactlyOne(
					c,
					keyAmong(
						physical.props(to.source),
						pairs.map((p) => p.target)
					),
					cx.ctx.evidenceContext
				)
				if (one !== undefined) {
					return {
						from,
						to,
						matched: pairs.map((p) => p.v),
						key: one.key,
						existence: one.existence,
						owed
					}
				}
			}
		}
	}
	return undefined
}

/**
 * `region` with the equalities `owed` (ContainedEquality) bound: a free field to the variable its pair binds, two free
 * fields to one fresh variable. A field is bound to the variable where it is of the variable's type, else to a fresh
 * variable of its own type the region equates with it (one variable has one type, as the checker's hidden variables do:
 * check/checker.ts RuleCheck `#equated`).
 */
const withOwed = (
	ed: DagEditor,
	region: Region,
	owed: NonEmptyReadonlyArray<OwedEquality>
): Region => {
	const vars: Array<VarDecl> = [...region.vars]
	const equalities: Array<Region["equalities"][number]> = [...region.equalities]
	const added = new Map<OccurrenceId, Array<{ readonly column: string; readonly var: VarDecl }>>()
	const typeAt = (side: FieldSide): ScalarType => {
		const o = defined(
			region.occurrences.find((x) => x.id === side.occurrence),
			"an owed field's occurrence is the region's"
		)
		return defined(
			o.source.current.heading.find((col) => col.name === side.column),
			"a containment's field is a column of its relation"
		).type
	}
	const fresh = (column: string, type: ScalarType): VarDecl => {
		const taken = new Set(vars.map((v) => v.name))
		let name = `__${column}`
		for (let n = 1; taken.has(name); n++) {
			name = `__${column}${String(n)}`
		}
		const v: VarDecl = { id: ed.freshVar(), name, type }
		vars.push(v)
		return v
	}
	const bind = (side: FieldSide, v: VarDecl): void => {
		const type = typeAt(side)
		const at = sameScalarType(type, v.type) ? v : fresh(side.column, type)
		if (at !== v) {
			equalities.push({ a: v, b: at })
		}
		added.getOrInsertComputed(side.occurrence, () => []).push({ column: side.column, var: at })
	}
	for (const e of owed) {
		if (e.from.var !== undefined) {
			bind(e.to, e.from.var)
		} else if (e.to.var !== undefined) {
			bind(e.from, e.to.var)
		} else {
			const v = fresh(e.from.column, typeAt(e.from))
			bind(e.from, v)
			bind(e.to, v)
		}
	}
	const occurrences = region.occurrences.map((o) => {
		const more = added.get(o.id)
		return more === undefined ? o : { ...o, bindings: [...o.bindings, ...more] }
	})
	return { ...region, vars, equalities, occurrences }
}

/**
 * The containment-equality rule (R03.containedEquality): an occurrence of a relation R read by its table, whose fields c
 * the catalog states contained in a relation S's fields d, and an occurrence of S that binds the fields of a physical
 * key of S among d to the variables the first binds at their pairs, read one fact of S per row, the fact R's c names, so
 * c_i = d_i at every other pair of the containment: the region binds the side that leaves its field free to the other's
 * variable, or both to one fresh variable where both leave it free (`withOwed`). Its set and multiplicity are unchanged:
 * it states an equality every row of it already holds. A seek of either occurrence then binds the column from the
 * other's row: den's scope reads, a step at its scope joined on the step to a value family keyed by the root, the step
 * and its own fields, each family's facts contained at the root and the step in the step's, bind the root from the
 * step's row, the family's own primary key prefix serving the read, where the step alone asked an index over it, a
 * B-tree insert on every value of the family. The certificate carries the key's premises and the containment's law, in
 * the context both hold in: none inside a transaction where the containment holds only at commit, where the current
 * transaction may have broken it.
 */
const containedEquality: Rule = {
	name: containedEqualityRule,
	/** The region's set is unchanged, so its metadata stands. */
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "MatchRegion" || node.occurrences.length < 2) {
			return false
		}
		return overPhysical(({ physical }) => {
			const e = containedEqualityOf(cx, physical, node)
			if (e === undefined) {
				return false
			}
			cx.certify({
				rule: containedEqualityRule,
				inputs: [e.from.source.id, e.to.source.id, cell.id],
				outputs: [cell.id],
				premises: [...e.key.just.premises, ...e.existence.premises],
				context: strongest([e.key.just.context, e.existence.context]),
				preservedHeading: node.heading.map((c) => c.name),
				equality: e.matched.map((v) => carrierEquality(baseOf(v.type).carrier)),
				coercion: e.key.just.coercions,
				params: undefined
			})
			cx.editor.set(cell, withOwed(cx.editor, node, e.owed))
			return true
		})
	}
}

/**
 * The pass's potential: each region's occurrences, and each occurrence's columns it neither binds nor fixes, which an
 * elimination and a key join lower by an occurrence and its free columns, and a containment's equality by the columns
 * it binds.
 */
const eliminationPotential: Potential = (cx) => {
	let count = 0
	for (const cell of cx.cells.order) {
		const node = cell.current
		if (node.kind === "MatchRegion") {
			for (const o of node.occurrences) {
				const held = new Set([
					...o.bindings.map((b) => b.column),
					...o.constants.map((c) => c.column)
				])
				count += 1 + o.source.current.heading.filter((col) => !held.has(col.name)).length
			}
		}
	}
	return count
}

/**
 * The R03 pass. The compilation's catalog (PassContext) supplies the installed constraints behind keys and
 * containments, from the schema's theory (laws/model/catalog.ts).
 *
 * R03: eliminate a relation only with a complete proof.
 *
 * Pattern: an occurrence O of a stored relation S in a region that supplies no demanded payload, filter, bound
 * identity or visibility restriction beyond a key match: O fixes no column, and every column it binds is a field of a
 * containment T(from) -> S(to) that another occurrence of a stored relation T binds to the same variable at the
 * matching field. Then, for every binding of the other occurrences, S has a matching fact (the containment) and at
 * most one (a key of S lies within the matched fields), so O neither filters nor multiplies the region, and removing
 * it from the owned IR leaves the region's set unchanged.
 *
 * The proof has four parts, each checked against admissible evidence only (analysis/physical/
 * evidence.ts):
 *
 * - at most one matching fact: a physical key of S, which the physical analysis proves from a valid immediate key
 *   constraint, or in a snapshot read from a deferrable one as committed-snapshot evidence;
 * - required existence in this context: the containment's constraint admitted as `exists` evidence, which refuses a
 *   deferred foreign key inside a transaction, where the current transaction may have broken it (a deferred
 *   law only promises an eventual target row);
 * - compatible equality: each matched field is bound to one variable, compared under the variable's native equality,
 *   which is the constraint's;
 * - unchanged authorization and visibility: a reader's scope is whole relations and no policy hides a fact,
 *   and S is a stored relation, never a derived one, which no law relates to its inputs.
 *
 * The certificate carries the key's and the containment's constraint premises and the context the evidence requires.
 *
 * Its key-join rule (R03.keyJoin) folds an occurrence into another of the same stored relation that binds every column
 * of a physical key of it to the same variables: both scan the one fact the key admits, so one occurrence binding what
 * both bind and fixing what both fix delivers the region's rows, each as often. The statement then makes one scan of
 * the relation whatever PostgreSQL's own self-join elimination would allow, and the access extraction, which reads the
 * same fold of the checked DAG (`keyJoinNormalDag`), plans one probe binding what both occurrences bind.
 *
 * Its containment-equality rule (R03.containedEquality) states in a region the equalities a containment and a key make
 * true of every row of it, binding a field one occurrence leaves free to the variable the other binds at its pair, so a
 * seek binds it and an occurrence of the containment's target that binds every field of it becomes one the elimination
 * removes.
 *
 * Potential: the occurrences in the reachable regions and the columns each neither binds nor fixes (eliminationPotential).
 */
export const eliminatePass = rewritePass({
	name: "eliminate",
	rules: [containedEquality, keyJoinFold, eliminateRule],
	potential: () => eliminationPotential
})
