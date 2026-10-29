import { analyzeDemand } from "#compiler/analysis/demand/demand.ts"
import { containmentEvidence } from "#compiler/analysis/physical/evidence.ts"
import type { JustifiedKey } from "#compiler/analysis/physical/fds.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import {
	type EvidenceContext,
	type ExistenceConstraint,
	type Premise,
	strongest
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
import { baseOf } from "#compiler/ir/scalar.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type Measure,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { overloadOf } from "#compiler/scalar/compute/registry.ts"

const eliminationRule = "R03.elimination"
const keyJoinRule = "R03.keyJoin"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>
type Base = KindOver<"Base", EditRefs>

interface Elimination {
	readonly occurrence: Occurrence
	readonly via: Occurrence
	readonly containment: ExistenceConstraint
	readonly key: JustifiedKey
	/** The containment's premises: its constraint's, or none when its enum type enforces it. */
	readonly existence: ReadonlyArray<Premise>
	readonly existenceContext: EvidenceContext
}

/**
 * The proof that removes stored occurrence `o`, scanning `s`, through occurrence `t`, scanning `tb`: a containment from
 * `tb`'s fields to `s`'s that `t` binds to every variable `o` binds, over a key of `s`, holding in the context.
 */
const eliminationVia = (
	cx: RewriteCx,
	o: Occurrence,
	s: Base,
	t: Occurrence,
	tb: Base
): Elimination | undefined => {
	for (const c of cx.catalog.containments) {
		if (
			c.from.relation !== tb.relation ||
			c.to.relation !== s.relation ||
			c.from.fields.length !== c.to.fields.length
		) {
			continue
		}
		const matched = o.bindings.every((b) => {
			const i = c.to.fields.indexOf(b.column)
			return (
				i >= 0 && t.bindings.some((x) => x.column === c.from.fields[i] && x.var.id === b.var.id)
			)
		})
		if (!matched || !c.to.fields.every((f) => o.bindings.some((b) => b.column === f))) {
			continue
		}
		const key = cx
			.physical()
			.of(o.source)
			.props.keys.find((k) => k.columns.every((col) => c.to.fields.includes(col)))
		if (key === undefined) {
			continue
		}
		const exists = containmentEvidence(c, cx.ctx.evidenceContext)
		if (exists === undefined) {
			continue
		}
		return {
			occurrence: o,
			via: t,
			containment: c,
			key,
			existence: exists.premises,
			existenceContext: exists.context
		}
	}
	return undefined
}

/** The proof that removes stored occurrence `o`, scanning `s`, through some other stored occurrence of the region. */
const eliminationOf = (
	cx: RewriteCx,
	region: Region,
	o: Occurrence,
	s: Base
): Elimination | undefined => {
	for (const t of region.occurrences) {
		const tb = t.source.current
		const found =
			t.id === o.id || tb.kind !== "Base" || tb.relationKind !== "relation"
				? undefined
				: eliminationVia(cx, o, s, t, tb)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** The first occurrence of a region the proof removes, with its proof. */
const elimination = (cx: RewriteCx, cell: Cell, region: Region): Elimination | undefined => {
	if (region.occurrences.length < 2 || cx.editor.readsFeedback(cell)) {
		return undefined
	}
	const d = cx.demand()
	for (const o of region.occurrences) {
		const s = o.source.current
		if (
			s.kind !== "Base" ||
			s.relationKind !== "relation" ||
			o.constants.length > 0 ||
			o.bindings.length === 0
		) {
			continue
		}
		const found = d.lateral(o.source) ? undefined : eliminationOf(cx, region, o, s)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** The native equality operators of the variables `bindings` bind, which a proof matching them compares under. */
const equalityOf = (bindings: Occurrence["bindings"]): ReadonlyArray<OpId> =>
	bindings.flatMap((b) => {
		const carrier = baseOf(b.var.type).carrier
		const op = overloadOf("eq", [carrier, carrier])
		return op === undefined ? [] : [op.id]
	})

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

/**
 * The first key join of a region (KeyJoin), in occurrence order: two occurrences `admits` lets fold, over one stored
 * relation, and the first of its keys (`keysOf`) both bind to one variable at every column.
 */
const keyJoinOf = <K extends { readonly columns: KeySet }>(
	region: Region,
	keysOf: (o: Occurrence, source: Base) => ReadonlyArray<K>,
	admits: (o: Occurrence) => boolean
): KeyJoin<K> | undefined => {
	const stored = region.occurrences.flatMap((o) => {
		const s = o.source.current
		return s.kind === "Base" && s.relationKind === "relation" && admits(o) ? [{ o, s }] : []
	})
	for (const [i, a] of stored.entries()) {
		for (const b of stored.slice(i + 1)) {
			const key =
				a.s.relation === b.s.relation
					? keysOf(a.o, a.s).find((k) => k.columns.every((c) => sameVariable(a.o, b.o, c)))
					: undefined
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
			cx.editor.readsFeedback(cell)
		) {
			return false
		}
		const physical = cx.physical()
		const d = cx.demand()
		const join = keyJoinOf(
			node,
			(o) => physical.of(o.source).props.keys,
			(o) => !d.lateral(o.source)
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
		const snapshot = editor.finished()
		const lateral = analyzeDemand(snapshot.dag, () => false).lateral
		const folded = (region: Region): Region => {
			const join = keyJoinOf(
				region,
				(_, s) => [s.primaryKey, ...s.keys].map((columns) => ({ columns })),
				(o) => !lateral(snapshot.node(o.source))
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
		const e = elimination(cx, cell, node)
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
	}
}

const eliminationMeasure: Measure = (cx) => {
	let count = 0
	for (const cell of cx.editor.topoOrder()) {
		const node = cell.current
		if (node.kind === "MatchRegion") {
			count += node.occurrences.length
		}
	}
	return [count]
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
 *   and S is a stored relation, never a derived one, whose contents are its last refresh and which no law
 *   relates to its inputs.
 *
 * A key match never moves an error frontier: a stored scan evaluates nothing. The certificate carries the key's and
 * the containment's constraint premises and the context the evidence requires.
 *
 * Its key-join rule (R03.keyJoin) folds an occurrence into another of the same stored relation that binds every column
 * of a physical key of it to the same variables: both scan the one fact the key admits, so one occurrence binding what
 * both bind and fixing what both fix delivers the region's rows, each as often. The statement then makes one scan of
 * the relation whatever PostgreSQL's own self-join elimination would allow, and the access extraction, which reads the
 * same fold of the checked DAG (`keyJoinNormalDag`), plans one probe binding what both occurrences bind.
 *
 * Measure: the number of occurrences in the reachable regions, which each elimination and each fold lowers by one.
 */
export const eliminatePass = rewritePass({
	name: "eliminate",
	rules: [keyJoinFold, eliminateRule],
	measure: eliminationMeasure
})
