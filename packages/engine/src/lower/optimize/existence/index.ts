import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { keyedBy } from "#compiler/analysis/physical/props.ts"
import type { NodeId, VarId } from "#compiler/core/ids.ts"
import { nodePremises } from "#compiler/ir/certificate.ts"
import { columnReads, type ScalarExpr } from "#compiler/ir/expr.ts"
import { drive } from "#compiler/ir/fold.ts"
import {
	type Cell,
	type EditRefs,
	exprsOf,
	keptRefs,
	type KindOver,
	mapNode,
	type OccurrenceOver,
	regionVarClasses,
	semiJoinRight,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf, sameScalarType } from "#compiler/ir/scalar.ts"
import {
	cellGraph,
	DagEditor,
	derivedMeta,
	widenedHeading
} from "#compiler/lower/optimize/demand/editor.ts"
import {
	type CellPhysical,
	overPhysical,
	type Potential,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import {
	linkedColumns,
	restrictionKept,
	roots
} from "#compiler/lower/optimize/demand/restriction.ts"
import { carrierEquality } from "#compiler/scalar/compute/registry.ts"

const semiJoinRule = "R02.semiJoin"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

/**
 * The variables of `region` an occurrence's source reads through a correlated reference to the region, by name: a
 * correlated source (a take or an aggregate correlated to the region's variable) is evaluated per value
 * of what it reads.
 */
const regionReads = (region: Cell, o: Occurrence): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const c of DagEditor.subtree(o.source)) {
		const reading = exprsOf(c.current).filter((e) => readsNode(e, region.id))
		if (isNonEmpty(reading)) {
			regionColumns(reading, region.id, out)
		}
	}
	return out
}

/** Adds to `out` the name of each column of `node` the expression trees `reading` read. */
const regionColumns = (
	reading: NonEmptyReadonlyArray<ScalarExpr>,
	node: NodeId,
	out: Set<string>
): void => {
	for (const r of columnReads(reading)) {
		if (r.node === node) {
			out.add(r.name)
		}
	}
}

/**
 * The classes of a region's variables one binding stands for another in (ir/rel.ts regionVarClasses): those its
 * equalities join between variables of one type, so a column one delivers is the other's, as a variable the match
 * shares is.
 */
const boundClasses = (region: Region): ((v: VarDecl) => VarId) =>
	regionVarClasses({
		equalities: region.equalities.filter((e) => sameScalarType(e.a.type, e.b.type))
	})

/**
 * The classes of the region's variables an occurrence binds without reading any variable of them (regionReads), each by
 * its class (ir/rel.ts regionVarClasses): a binder in scope for every other occurrence, a region equality's two
 * variables one. Reads and bindings are told apart by class, as binders are counted: a correlated source that reads one
 * variable of a class and binds another, `Owned.bind({ owner: item.id })` matched at `id: owned.id` under `item.id =
 * owned.id`, follows the class's other binder, so it binds none of it, and the other binder is no existence test.
 */
const unreadBindings = (
	region: Cell,
	node: Region,
	o: Occurrence,
	classOf: (v: VarDecl) => VarId
): ReadonlySet<VarId> => {
	const reads = regionReads(region, o)
	const read = new Set(node.vars.filter((v) => reads.has(v.name)).map(classOf))
	return new Set(o.bindings.map((b) => classOf(b.var)).filter((c) => !read.has(c)))
}

/**
 * Whether the expression tree `e` reads a column of `node`: its dependencies hold every node a column of its closure
 * reads (ir/expr.ts builtExpr), so an expression that reads none of the region's is never walked for its columns, where
 * every expression of every cell below every occurrence was (qti's write compile at hub f1bf91a2f: their closures took
 * 72 s of 661 s of its readback lowering).
 */
const readsNode = (e: ScalarExpr, node: NodeId): boolean => e.deps.nodes.includes(node)

/**
 * The existence-only occurrences of a region as its cells say, which no lateral read may name. A variable
 * counts as bound elsewhere only by an occurrence that does not
 * itself read it: a correlated source binding the variable it is correlated on needs another binder in scope before
 * it, so an occurrence whose only other binder of a variable is such a source is that binder, not an
 * existence test, and moving it into a semi-join would leave the correlated source with nothing to follow.
 */
const shapedExistence = (cx: RewriteCx, cell: Cell, region: Region): ReadonlyArray<Occurrence> => {
	if (region.occurrences.length < 2 || cx.cells.feedback.has(cell)) {
		return []
	}
	const classOf = boundClasses(region)
	/**
	 * Each occurrence's classes of variables it binds without reading them, index for index: a variable a where equates
	 * to a row in hand's is bound where the row's is, as one the match shares is (where-reach.test.ts).
	 */
	const binds = region.occurrences.map((x) => unreadBindings(cell, region, x, classOf))
	/**
	 * How many occurrences bind each class without reading it: one binds it elsewhere for an occurrence when more do
	 * than the occurrence itself, so each occurrence asks a count, where it gathered every other occurrence's bindings
	 * again, quadratic in the region's occurrences (qti's write compile at hub f1bf91a2f: 74 s of 661 s of its readback
	 * lowering). The occurrences of a region are told apart by their places, their ids being fresh.
	 */
	const binders = new Map<VarId, number>()
	for (const classes of binds) {
		for (const c of classes) {
			binders.set(c, (binders.get(c) ?? 0) + 1)
		}
	}
	return region.occurrences.filter((o, at) => {
		const own = defined(binds[at], "an occurrence's bindings, index for index")
		if (
			!o.bindings.every((b) => {
				const c = classOf(b.var)
				return (binders.get(c) ?? 0) > (own.has(c) ? 1 : 0)
			})
		) {
			return false
		}
		if (columnReads(o.constants.map((c) => c.expr)).length > 0) {
			return false
		}
		return !DagEditor.correlated(o.source) && !cx.cells.feedback.has(o.source)
	})
}

/** A region's existence-only occurrences (shapedExistence) as worked out at an editor version, for its node then. */
interface Shaped {
	readonly node: Region
	readonly at: number
	readonly occurrences: ReadonlyArray<Occurrence>
}

/**
 * Each editor's regions' existence-only occurrences, by cell (shapedOf): what a region's shape reads, its node, its
 * sources' subtrees and whether they read a recursion's feedback, is all of the region's subtree, so it stands for as
 * long as no node of that subtree is set again (CellState stamp).
 */
const shapes = new WeakMap<DagEditor, Map<Cell, Shaped>>()

/**
 * A region's existence-only occurrences (shapedExistence), kept by the editor until a node of the region's subtree is
 * set again, so the potential the driver measures at every state and the rule's scan work them out again for the
 * regions an edit reached alone, where both worked out every region at every state (qti's write compile at hub
 * f1bf91a2f: about 34M of them in its read-backs' rewrite passes).
 */
const shapedOf = (cx: RewriteCx, cell: Cell, region: Region): ReadonlyArray<Occurrence> => {
	let kept = shapes.get(cx.editor)
	if (kept === undefined) {
		kept = new Map()
		shapes.set(cx.editor, kept)
	}
	const known = kept.get(cell)
	if (known?.node === region && known.at >= cx.cells.stamp(cell)) {
		return known.occurrences
	}
	const occurrences = shapedExistence(cx, cell, region)
	kept.set(cell, { node: region, at: cx.editor.version, occurrences })
	return occurrences
}

/**
 * The number of groups `occurrences` form, two occurrences in one group when a chain of shared variables joins them; a
 * region equality makes its two variables one.
 */
const groups = (region: Region, occurrences: ReadonlyArray<Occurrence>): number => {
	const parent = new Map<string, string>()
	const find = (x: string): string => {
		let root = x
		for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root)) {
			root = up
		}
		parent.set(x, root)
		return root
	}
	const union = (a: string, b: string): void => {
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) {
			parent.set(ra, rb)
		}
	}
	for (const e of region.equalities) {
		union(`v${e.a.id}`, `v${e.b.id}`)
	}
	for (const o of occurrences) {
		parent.set(`o${o.id}`, find(`o${o.id}`))
		for (const b of o.bindings) {
			union(`o${o.id}`, `v${b.var.id}`)
		}
	}
	return new Set(occurrences.map((o) => find(`o${o.id}`))).size
}

/**
 * The filters stacked over `cell`, nearest first, each with the cell it reads: each single reader above it while it is
 * a filter, whose columns are its input's, so each reads the region's columns by their names.
 */
const filtersAbove = (
	cx: RewriteCx,
	cell: Cell
): ReadonlyArray<{ readonly below: Cell; readonly pred: ScalarExpr }> => {
	const [above, ...more] = cx.cells.readers(cell)
	if (above === undefined || more.length > 0) {
		return []
	}
	const node = above.current
	return node.kind === "Filter"
		? [{ below: cell, pred: node.pred }, ...filtersAbove(cx, above)]
		: []
}

/**
 * Whether a filter over `region` (`filtersAbove`) reads a variable `o` alone binds beside a variable of a class none of
 * `o`'s bindings is in: a condition that joins `o` to the rest of the region past the class equality, as the digest
 * equality a join of a digested text states joins the text's digest to the other side's text, `h = sha256(u)` beside
 * `t = u` (check/checker.ts #stateDigests). A semi-join's column pairs carry no such condition, so the rewrite reads it
 * at the class's other binder, `h = sha256(t)`, which reads `o` no longer: the read of T then binds its text by `o`'s
 * row alone, seeks by no digest and is refused as undigested (test/unit/physical/digest-seeks, "a joined text" and "a
 * shared variable"). Such an `o` stays a join operand, read where its rows drive the condition.
 */
const joinedAbove = (cx: RewriteCx, cell: Cell, region: Region, o: Occurrence): boolean => {
	const classOf = boundClasses(region)
	const own = new Set(
		o.bindings
			.filter(
				(b) =>
					!region.occurrences.some(
						(x) => x.id !== o.id && x.bindings.some((q) => q.var.id === b.var.id)
					)
			)
			.map((b) => b.var.name)
	)
	if (own.size === 0) {
		return false
	}
	const classes = new Set(o.bindings.map((b) => classOf(b.var)))
	const apart = new Set(region.vars.filter((v) => !classes.has(classOf(v))).map((v) => v.name))
	return filtersAbove(cx, cell).some(({ below, pred }) => {
		const read = columnReads([pred]).filter((r) => r.node === below.id)
		return read.some((r) => own.has(r.name)) && read.some((r) => apart.has(r.name))
	})
}

/** The existence-only occurrences of `candidates` whose removal joins no two inputs without a condition. */
const connectedOf = (
	region: Region,
	candidates: ReadonlyArray<Occurrence>
): ReadonlyArray<Occurrence> => {
	const whole = groups(region, region.occurrences)
	return candidates.filter(
		(o) =>
			groups(
				region,
				region.occurrences.filter((x) => x.id !== o.id)
			) ===
			whole - (o.bindings.length === 0 ? 1 : 0)
	)
}

/**
 * Whether `o`, read at `columns` beside its constants, binds a physical key of its source: at most one row of it per
 * binding of the others.
 */
const keyedRead = (
	physical: CellPhysical,
	o: Occurrence,
	columns: ReadonlyArray<string>
): boolean =>
	keyedBy(physical.props(o.source), [...columns, ...o.constants.map((c) => c.column)])?.just.outer
		.length === 0

/**
 * Whether removing `o` keeps the restriction reaching every other occurrence's read (demand/restriction.ts
 * restrictionKept), so none is read at fewer columns than the region bound it at.
 */
const keepsRestriction = (region: Region, o: Occurrence): boolean =>
	restrictionKept(
		linkedColumns(region),
		linkedColumns({ ...region, occurrences: region.occurrences.filter((x) => x.id !== o.id) })
	)

/**
 * Whether `o` can only filter the region left once it is removed, never drive it: that region has roots (demand/
 * restriction.ts roots), one occurrence binding a key of every other through their keys, so each of its rows is a root
 * row's with one row of each other beside it and no product is left for the existence test to filter; and `o` binds no
 * key of any root, so no read of `o` first could single out the root's rows by their key. Such an `o` is one probe at
 * its key per row, whatever restriction its removal takes; one that binds a root's key may be the smaller side the
 * region is read from, and stays a join operand.
 */
const onlyFilters = (physical: CellPhysical, region: Region, o: Occurrence): boolean => {
	const rest = region.occurrences.filter((x) => x.id !== o.id)
	const at = (place: number): Occurrence =>
		defined(rest[place], "an occurrence of the region, place for place")
	const found = roots({ ...region, occurrences: rest }, (place, columns) =>
		keyedRead(physical, at(place), columns)
	)
	const classOf = regionVarClasses(region)
	const checked = new Set(o.bindings.map((b) => classOf(b.var)))
	return (
		found.length > 0 &&
		found.every((place) => {
			const root = at(place)
			return !keyedRead(
				physical,
				root,
				root.bindings.flatMap((b) => (checked.has(classOf(b.var)) ? [b.column] : []))
			)
		})
	)
}

/** The first of `connected` whose bound and constant columns key no physical key of its source, or the first. */
const unkeyedFirst = (
	physical: CellPhysical,
	connected: NonEmptyReadonlyArray<Occurrence>
): Occurrence =>
	connected.find(
		(o) =>
			!keyedRead(
				physical,
				o,
				o.bindings.map((b) => b.column)
			)
	) ?? connected[0]

/**
 * The rest of a region whose reads of the region's columns `renamed` names read the columns they are renamed to: each
 * occurrence's constants, and every cell of its source's subtree that reads the region, rewritten (the cells returned,
 * by label); an occurrence that reads none of them as it was.
 */
const redirectReads = (
	ed: DagEditor,
	region: Cell,
	rest: ReadonlyArray<Occurrence>,
	renamed: ReadonlyMap<string, string>
): { readonly occurrences: ReadonlyArray<Occurrence>; readonly cells: ReadonlyArray<NodeId> } => {
	if (renamed.size === 0) {
		return { occurrences: rest, cells: [] }
	}
	const copy = ed.copier((ref, expr) => {
		const to = ref.node === region.id ? renamed.get(ref.name) : undefined
		return to === undefined
			? undefined
			: ed.expr({
					kind: "column",
					column: { node: region.id, name: to },
					args: [],
					type: expr.type,
					nonNull: expr.nonNull
				})
	})
	const cells: Array<NodeId> = []
	for (const c of new Set(rest.flatMap((x) => [...DagEditor.subtree(x.source)]))) {
		const node = c.current
		if (!exprsOf(node).some((e) => readsNode(e, region.id))) {
			continue
		}
		const next = drive(
			mapNode<EditRefs, EditRefs>(node, { ...keptRefs, expr: (e) => copy.of(e) }),
			(input) => input
		)
		if (next !== node) {
			ed.set(c, next)
			cells.push(c.id)
		}
	}
	return {
		occurrences: rest.map((x) => ({
			...x,
			constants: x.constants.map((k) => ({ ...k, expr: copy.of(k.expr) }))
		})),
		cells
	}
}

const rewrite = (cx: RewriteCx, cell: Cell, region: Region, o: Occurrence): void => {
	const ed: DagEditor = cx.editor
	const classOf = boundClasses(region)
	const rest = region.occurrences.filter((x) => x.id !== o.id)
	/**
	 * The variables each of the rest binds without reading their classes (unreadBindings): the binders a variable of `o`
	 * may stand as, never a correlated source's binding of a class it reads, which would read itself.
	 */
	const unread = rest.flatMap((x) => {
		const classes = unreadBindings(cell, region, x, classOf)
		return x.bindings.flatMap((q) => (classes.has(classOf(q.var)) ? [q.var] : []))
	})
	/**
	 * The variable of each of `o`'s variables' classes the rest of the region binds, by the variable: itself where
	 * another occurrence binds it, else the first another occurrence binds of its class without reading it, which a where
	 * equated to it (shapedExistence, which counts those binders alone): the semi-join reads that one, and `o`'s own,
	 * bound by `o` alone, leaves the region.
	 */
	const boundBy = new Map<VarId, VarDecl>()
	for (const b of o.bindings) {
		const own = rest.some((x) => x.bindings.some((q) => q.var.id === b.var.id))
		const other = unread.find((v) => classOf(v) === classOf(b.var))
		boundBy.set(
			b.var.id,
			own ? b.var : defined(other, "a class another occurrence binds (shapedExistence)")
		)
	}
	/** `o`'s variables the rest binds none of, each by the one of its class the rest binds. */
	const replaced = new Map(
		[...boundBy].flatMap(([id, v]) => (v.id === id ? [] : [[id, v] as const]))
	)
	/** A variable of the rest of the region: `o`'s own the rest binds no longer, its class's (`boundBy`). */
	const kept = (v: VarDecl): VarDecl => replaced.get(v.id) ?? v
	/**
	 * Each of `o`'s variables the rest binds no longer, by its name, the name of the one of its class the rest binds,
	 * which stands for it in every row: a correlated source of the rest that read it (`Owned.bind({ owner: item.owner })`
	 * beside `item.owner = slot.item`, Item the occurrence moved) reads that one instead, so it follows the occurrence
	 * that binds it.
	 */
	const renamed = new Map(
		region.vars.flatMap((v) => {
			const to = replaced.get(v.id)
			return to === undefined ? [] : [[v.name, to.name] as const]
		})
	)
	const redirected = redirectReads(ed, cell, rest, renamed)
	/**
	 * Each shared variable and the witness variable that stands for it in the existence test, and the occurrence's
	 * bindings onto the witnesses.
	 */
	const fresh = new Map<VarId, { readonly shared: VarDecl; readonly witness: VarDecl }>()
	const bindings: Array<{ readonly column: string; readonly var: VarDecl }> = []
	for (const b of o.bindings) {
		const known = fresh.get(b.var.id)
		if (known !== undefined) {
			bindings.push({ column: b.column, var: known.witness })
			continue
		}
		const v = b.var
		const witness: VarDecl = { id: ed.freshVar(), name: v.name, type: v.type }
		fresh.set(v.id, { shared: kept(v), witness })
		bindings.push({ column: b.column, var: witness })
	}
	const occurrence = ed.freshOccurrence()
	const witnesses = [...fresh.values()].map((f) => f.witness)
	const right = ed.add({
		kind: "MatchRegion",
		scope: ed.freshScope(),
		vars: witnesses,
		occurrences: [
			{
				id: occurrence,
				source: o.source,
				bindings,
				constants: o.constants
			}
		],
		equalities: [],
		correlated: [],
		heading: witnesses.map((w) => ({ name: w.name, type: w.type })),
		meta: derivedMeta(region.meta),
		loc: undefined
	})
	const on = [...fresh.values()].map(({ shared, witness }) => ({
		left: shared.name,
		right: witness.name
	}))
	/**
	 * The semi-join reads the shared variables as columns of the remaining region: one the region does not deliver
	 * (a join variable outside its heading) widens it, a variable `o` alone bound leaves it for its class's (`kept`),
	 * and a projection restores the heading the region had.
	 */
	const heading = widenedHeading(
		region.heading.filter((c) => !region.vars.some((v) => v.name === c.name && replaced.has(v.id))),
		[...fresh.values()].map((f) => f.shared)
	)
	const restored =
		replaced.size > 0 || heading.length !== region.heading.length
			? region.heading.map((c) => {
					const v = region.vars.find((x) => x.name === c.name)
					return { column: c, from: v === undefined ? c.name : kept(v).name }
				})
			: undefined
	ed.set(cell, {
		...region,
		vars: region.vars.filter((v) => !replaced.has(v.id)),
		occurrences: redirected.occurrences,
		equalities: region.equalities.flatMap((e) => {
			const [a, b] = [kept(e.a), kept(e.b)]
			return a.id === b.id ? [] : [{ a, b }]
		}),
		correlated: region.correlated.map((c) => ({ ...c, var: kept(c.var) })),
		heading,
		meta: derivedMeta(region.meta)
	})
	const outputs: Array<NodeId> = [cell.id, right.id, ...redirected.cells]
	ed.insertAbove(cell, (left) => {
		const semi = ed.add({
			kind: "SemiJoin",
			left,
			right: defined(
				semiJoinRight(cellGraph, left, right),
				"an existence-only occurrence's source reads nothing outside it (shapedExistence), so none of its region"
			),
			on,
			heading,
			meta: restored === undefined ? region.meta : derivedMeta(region.meta),
			loc: undefined
		})
		outputs.push(semi.id)
		if (restored === undefined) {
			return semi
		}
		const projected = ed.add({
			kind: "ProjectSet",
			input: semi,
			out: restored.map(({ column, from }) => ({
				name: column.name,
				expr: ed.column(
					semi,
					defined(
						heading.find((h) => h.name === from),
						"a column the semi-join delivers"
					)
				)
			})),
			heading: region.heading,
			meta: region.meta,
			loc: undefined
		})
		outputs.push(projected.id)
		return projected
	})
	const equality = witnesses.map((w) => carrierEquality(baseOf(w.type).carrier))
	cx.certify({
		rule: semiJoinRule,
		inputs: [o.source.id, cell.id],
		outputs,
		premises: nodePremises([o.source.id]),
		context: "queryLocal",
		preservedHeading: region.heading.map((c) => c.name),
		equality,
		coercion: [],
		params: undefined
	})
}

const existenceRule: Rule = {
	name: semiJoinRule,
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "MatchRegion") {
			return false
		}
		const shaped = shapedOf(cx, cell, node)
		if (shaped.length === 0) {
			return false
		}
		const candidates = shaped.filter(
			(o) => !cx.cells.lateral(o.source) && !joinedAbove(cx, cell, node, o)
		)
		if (candidates.length === 0) {
			return false
		}
		const connected = connectedOf(node, candidates)
		if (!isNonEmpty(connected)) {
			return false
		}
		const keeping = connected.filter((o) => keepsRestriction(node, o))
		const [only, ...more] = connected
		if (more.length === 0 && keeping.length === 1) {
			rewrite(cx, cell, node, only)
			return true
		}
		return overPhysical(({ physical }) => {
			const admitted = connected.filter(
				(o) => keeping.includes(o) || onlyFilters(physical, node, o)
			)
			if (!isNonEmpty(admitted)) {
				return false
			}
			rewrite(cx, cell, node, unkeyedFirst(physical, admitted))
			return true
		})
	}
}

/**
 * A set comparison over equal headings is an existence test on every column ("NOT EXISTS for
 * anti-matches"): L intersect R is the rows of L with an equal row in R, and L except R those without one, compared
 * under each column's native equality, which is the set operators' own (no NULL ever makes them differ).
 * The semi- or anti-join lets PostgreSQL probe R's indexes instead of hashing both sides into an in-memory SetOp.
 *
 * Physically the two are different forms: INTERSECT and EXCEPT deduplicate their whole heading, while a semi- or
 * anti-join keeps its left input's multiplicity and does not repair a repeating left input. The rewrite
 * is admitted only with a multiplicity proof: a physical key of the left input on the heading,
 * proved in the artifact's evidence context and not merely per outer row, so the left side has one row per tuple and
 * the semi- or anti-join has the set operator's 0/1 result whatever the right side repeats. The key's premises and
 * context are the certificate's. Otherwise the set form stays.
 */
const antiJoinRule = "R02.antiJoin"

const setComparison: Rule = {
	name: antiJoinRule,
	at: (cell, cx) => {
		const ed = cx.editor
		const node = cell.current
		if (node.kind !== "Intersect" && node.kind !== "Difference") {
			return false
		}
		if (DagEditor.correlated(node.right)) {
			return false
		}
		const { left, right } = node
		return cx.cells.lateral(right)
			? false
			: overPhysical(({ physical }) => {
					const equality = node.heading.map((c) => carrierEquality(baseOf(c.type).carrier))
					const unique = keyedBy(
						physical.props(left),
						node.heading.map((c) => c.name)
					)
					if (unique === undefined || unique.just.outer.length > 0) {
						return false
					}
					const on = node.heading.map((c) => ({ left: c.name, right: c.name }))
					cx.certify({
						rule: node.kind === "Intersect" ? semiJoinRule : antiJoinRule,
						inputs: [node.left.id, node.right.id],
						outputs: [cell.id],
						premises: [...unique.just.premises, ...nodePremises([node.left.id, node.right.id])],
						context: unique.just.context,
						preservedHeading: node.heading.map((c) => c.name),
						equality: [...equality, ...unique.just.equality],
						coercion: unique.just.coercions,
						params: undefined
					})
					const kept = { left, on, heading: node.heading, meta: node.meta, loc: node.loc }
					ed.set(
						cell,
						node.kind === "Intersect"
							? {
									kind: "SemiJoin",
									...kept,
									right: defined(
										semiJoinRight(cellGraph, left, right),
										"a set comparison's right side reads nothing outside it (setComparison), so none of its left"
									)
								}
							: { kind: "AntiJoin", ...kept, right }
					)
					return true
				})
	}
}

export const existencePotential: Potential = (cx) => {
	let comparisons = 0
	const shaped: Array<Occurrence> = []
	for (const cell of cx.cells.order) {
		const node = cell.current
		if (node.kind === "MatchRegion") {
			appendAll(shaped, shapedOf(cx, cell, node))
		}
		if (node.kind === "Intersect" || node.kind === "Difference") {
			comparisons++
		}
	}
	return shaped.length === 0
		? comparisons
		: comparisons + shaped.filter((o) => !cx.cells.lateral(o.source)).length
}

/**
 * The R02 pass.
 *
 * R02: express existence as existence.
 *
 * Pattern: an occurrence of a region that contributes only whether a compatible fact exists: every variable it binds
 * is bound by another occurrence too, so none of its columns is a contribution of its own ("an unbound
 * matching field is existential ... only the former can be dropped by a semi-join transformation without an
 * additional proof"). The region's set is then the set of the other occurrences' bindings that have such a fact:
 *
 *   pi_V(O1 |><| ... |><| Ok)  =  pi_V(O1 |><| ... |><| Ok-1)  semi-join  Ok  on Ok's variables
 *
 * so the occurrence leaves the region and becomes the right side of a SemiJoin over it: a one-occurrence region over
 * the same source with fresh variables for the same columns and the same constants, correlated on the shared
 * variables. The lowering emits it as EXISTS (SELECT 1 ...), which PostgreSQL plans as a semi-join and which consumes
 * one witness per selected row instead of every matching one. Whether the EXISTS target list may also drop
 * its DISTINCT is the separate R02.existence multiplicity certificate of dedup placement.
 *
 * A variable bound only by the occurrence is a contribution or a dead witness, and demand pruning (../prune) makes a
 * dead one existential first; a match binding a witness id another stage reads is never touched. A correlated source,
 * a source some expression reads laterally (another occurrence's constant included), a constant that reads another
 * node, and a region on a recursive step are refused: the semi-join's right side is evaluated in another scope.
 *
 * An intersection or a difference is likewise an existence test on every column, and becomes a SemiJoin or an AntiJoin
 * (R02.antiJoin), lowered as EXISTS or NOT EXISTS, when its left input is proved physically unique.
 *
 * A shared variable the region does not deliver (a join variable outside its heading, which validation allows) is
 * read by the semi-join from the region widened by it, and a projection restores the region's heading.
 *
 * Which occurrence, and whether any. Being existence-only is necessary, not sufficient: the rewrite must yield one
 * witness per parent with the least work. Three conditions decide it, each structural and deterministic:
 *
 * - No cross join. The occurrence's removal must not split the remaining occurrences into more groups than the region
 *   already has, where two occurrences are joined when they bind one variable (or variables a region equality makes
 *   equal). An occurrence that connects two others, the interior of a chain or the Task between Account and Note, is a
 *   join edge: as a semi-join it would leave its neighbours in one FROM list with no condition between them, joined
 *   only by the EXISTS above, a filter of their product. A join without a condition appears only where the query has
 *   one.
 * - Witness multiplicity first. An occurrence whose bound and constant columns determine a physical key of its source
 *   has at most one witness per binding of the others, so a semi-join consumes no fewer rows than the join it replaces;
 *   one without such a key can have many, and is the existence test that saves work. Unkeyed candidates are taken
 *   before keyed ones, each group in the region's occurrence order. The key decides only the choice, never the rewrite's
 *   validity, so it is no premise of the certificate.
 * - No restriction lost. The occurrence's removal must leave every other occurrence restricted at each column the region
 *   restricted it at (demand/restriction.ts linkedColumns, restrictionKept), the pipeline's invariant that no rewrite
 *   reduces the restriction reaching any occurrence's read: no cross join, at the granularity of a column. An occurrence
 *   that is the only one relating some column of another to the rest is a join edge at that column: as a semi-join it
 *   would leave the other read at every value of the column, related to the rest only by the EXISTS above it. A stored
 *   relation so read PostgreSQL may yet drive from the EXISTS, but a source the lowering reads apart (a union, a fold, a
 *   chain's fenced step) it cannot: metis's sitting read each item session's attempts in force, a union over every member
 *   of the item's test, at the session's package alone, the member that carries the item to its place an EXISTS above,
 *   68 rows derived and five tests probed for each of 34 items (9,825 buffers of 31,173).
 *   A removal that takes a restriction is admitted where the occurrence can only filter what is left (onlyFilters): the
 *   region left has roots (demand/restriction.ts roots), one occurrence binding a key of every other through their
 *   keys, so each of its rows is a root row's and no product is left for the test to filter, and the occurrence binds no
 *   key of any root, so it could never be read first to single out the root's rows. pantry's operands keep their
 *   operator's placement an existence test: the operand's placement is the root, the operator's binds no key of it, and
 *   held in the join it led a flat fill of UnknownOperandBase to read 174M buffers where the test read 66.5M. An
 *   occurrence that binds a root's key stays a join operand, the smaller side the region may be read from: the
 *   expressions among a document's nodes, which bind the node's key, read first in a fill of ExpressionOperand took 1.73M
 *   buffers where every node read and its expression probed took 14.62M.
 * No bound on nesting: an EXISTS is a subplan reading its relations through one probe (sql/bind.ts), which PostgreSQL
 * never flattens into its input's join problem, so stacking one more over a region grows no join problem past
 * join_collapse_limit, and the binding pass nests every level within it.
 *
 * Potential: the number of existence-only occurrences plus set comparisons, at most the DAG's nodes and occurrences,
 * which each rewrite lowers: a region loses one occurrence and the new right side has a single one, which is never
 * existence-only; a set comparison becomes a join. The choice above only selects among the counted occurrences, so the
 * potential does not depend on it.
 */
export const existencePass = rewritePass({
	name: "existence",
	rules: [existenceRule, setComparison],
	potential: () => existencePotential
})
