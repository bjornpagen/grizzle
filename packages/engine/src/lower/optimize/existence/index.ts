import { keyedBy } from "#compiler/analysis/physical/props.ts"
import type { NodeId, VarId } from "#compiler/core/ids.ts"
import { postgresSource, published } from "#compiler/core/limits.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	type Cell,
	type EditRefs,
	exprsOf,
	type KindOver,
	type OccurrenceOver,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import {
	columnRefs,
	type DagEditor,
	derivedMeta,
	widenedHeading
} from "#compiler/lower/optimize/demand/editor.ts"

import {
	type Potential,
	nodePremises,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { overloadOf } from "#compiler/scalar/compute/registry.ts"

const semiJoinRule = "R02.semiJoin"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

/**
 * The variables of `region` an occurrence's source reads through a correlated reference to the region, by name: a
 * correlated source (a take or an aggregate correlated to the region's variable) is evaluated per value
 * of what it reads.
 */
const regionReads = (cx: RewriteCx, region: Cell, o: Occurrence): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const c of cx.editor.subtree(o.source)) {
		for (const r of columnRefs(exprsOf(c.current)).filter((ref) => ref.node === region.id)) {
			out.add(r.name)
		}
	}
	return out
}

/**
 * The existence-only occurrences of a region. A variable counts as bound elsewhere only by an occurrence that does not
 * itself read it: a correlated source binding the variable it is correlated on needs another binder in scope before
 * it, so an occurrence whose only other binder of a variable is such a source is that binder, not an
 * existence test, and moving it into a semi-join would leave the correlated source with nothing to follow.
 */
const existenceOnly = (cx: RewriteCx, cell: Cell, region: Region): ReadonlyArray<Occurrence> => {
	const ed = cx.editor
	if (region.occurrences.length < 2 || ed.readsFeedback(cell)) {
		return []
	}
	const d = cx.demand()
	/** Each occurrence with the region's variables it reads. */
	const scanned = region.occurrences.map((x) => ({
		occurrence: x,
		reads: regionReads(cx, cell, x)
	}))
	return region.occurrences.filter((o) => {
		const others = scanned.filter((x) => x.occurrence.id !== o.id)
		const elsewhere = new Set(
			others.flatMap((x) =>
				x.occurrence.bindings.filter((b) => !x.reads.has(b.var.name)).map((b) => b.var.id)
			)
		)
		if (!o.bindings.every((b) => elsewhere.has(b.var.id))) {
			return false
		}
		if (columnRefs(o.constants.map((c) => c.expr)).length > 0) {
			return false
		}
		if (d.lateral(o.source)) {
			return false
		}
		return !ed.correlated(o.source) && !ed.readsFeedback(o.source)
	})
}

/**
 * PostgreSQL's default join_collapse_limit, which is from_collapse_limit's too: the most FROM items the planner flattens
 * one join problem into, and plans exhaustively, before it plans the rest as separate subproblems in the order written.
 * No grizzle session sets either, so the default is the value every statement is planned under. The docs state it
 * through from_collapse_limit, "By default, this variable is set the same as from_collapse_limit", whose "default is
 * eight" (https://www.postgresql.org/docs/19/runtime-config-query.html).
 */
export const collapseLimit = published({
	value: 8,
	owner: "PostgreSQL 19rc1's planner",
	unit: "FROM items",
	scope:
		"one join problem the planner flattens, under the session default no grizzle session changes",
	constraint: "configurable default",
	source: `${postgresSource}/src/backend/utils/misc/guc_parameters.dat#L1529-L1537`,
	quote:
		"{ name => 'join_collapse_limit', type => 'int', context => 'PGC_USERSET', [...] boot_val => '8',",
	verified: "2026-11-05"
})

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
 * The relations of the semi- and anti-joins stacked over `region`: the chain of single readers above it through
 * filters, projections and the left side of each semi- or anti-join, each of whose right sides counts its occurrences
 * (one relation when it is no region). It stops at a shared node (two references, from one reader or two;
 * DagEditor.readers), a root, or any other reader.
 */
const stacked = (cx: RewriteCx, region: Cell): number => {
	const ed = cx.editor
	const readers = ed.readers()
	let count = 0
	for (let at = region; !ed.isRoot(at);) {
		const [above, ...more] = readers(at)
		if (above === undefined || more.length > 0) {
			break
		}
		const node = above.current
		const semi = node.kind === "SemiJoin" || node.kind === "AntiJoin"
		if (semi ? node.left !== at : node.kind !== "Filter" && node.kind !== "ProjectSet") {
			break
		}
		if (semi) {
			const right = node.right.current
			count += right.kind === "MatchRegion" ? right.occurrences.length : 1
		}
		at = above
	}
	return count
}

/**
 * The occurrence the rewrite moves into a semi-join, if any: an existence-only occurrence whose removal joins no two
 * inputs without a condition, an unkeyed one before a keyed one, while the stacked semi-joins stay within the collapse
 * limit (the header's three conditions).
 */
const existenceTest = (cx: RewriteCx, cell: Cell, region: Region): Occurrence | undefined => {
	const candidates = existenceOnly(cx, cell, region)
	if (candidates.length === 0) {
		return undefined
	}
	if (region.occurrences.length + stacked(cx, cell) > collapseLimit.value) {
		return undefined
	}
	const whole = groups(region, region.occurrences)
	const connected = candidates.filter(
		(o) =>
			groups(
				region,
				region.occurrences.filter((x) => x.id !== o.id)
			) ===
			whole - (o.bindings.length === 0 ? 1 : 0)
	)
	if (connected.length <= 1) {
		return connected[0]
	}
	const physical = cx.physical()
	const keyed = (o: Occurrence): boolean => {
		const source = physical.of(o.source).props
		const key = keyedBy(source, [
			...o.bindings.map((b) => b.column),
			...o.constants.map((c) => c.column)
		])
		return key?.just.outer.length === 0
	}
	return connected.find((o) => !keyed(o)) ?? connected[0]
}

const rewrite = (cx: RewriteCx, cell: Cell, region: Region, o: Occurrence): void => {
	const ed: DagEditor = cx.editor
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
		fresh.set(v.id, { shared: v, witness })
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
	 * (a join variable outside its heading) widens it, and a projection restores the heading the region had.
	 */
	const heading = widenedHeading(
		region.heading,
		[...fresh.values()].map((f) => f.shared)
	)
	const widened = heading.length > region.heading.length
	ed.set(cell, {
		...region,
		occurrences: region.occurrences.filter((x) => x.id !== o.id),
		heading,
		meta: derivedMeta(region.meta)
	})
	const outputs: Array<NodeId> = [cell.id, right.id]
	ed.insertAbove(cell, (left) => {
		const semi = ed.add({
			kind: "SemiJoin",
			left,
			right,
			on,
			heading,
			meta: widened ? derivedMeta(region.meta) : region.meta,
			loc: undefined
		})
		outputs.push(semi.id)
		if (!widened) {
			return semi
		}
		const restored = ed.add({
			kind: "ProjectSet",
			input: semi,
			out: region.heading.map((c) => ({ name: c.name, expr: ed.column(semi, c) })),
			heading: region.heading,
			meta: region.meta,
			loc: undefined
		})
		outputs.push(restored.id)
		return restored
	})
	const equality = witnesses.flatMap((w) => {
		const carrier = baseOf(w.type).carrier
		const op = overloadOf("eq", [carrier, carrier])
		return op === undefined ? [] : [op.id]
	})
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
		const o = existenceTest(cx, cell, node)
		if (o === undefined) {
			return false
		}
		rewrite(cx, cell, node, o)
		return true
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
		if (cx.demand().lateral(node.right) || ed.correlated(node.right)) {
			return false
		}
		const equality = node.heading.flatMap((c) => {
			const carrier = baseOf(c.type).carrier
			const op = overloadOf("eq", [carrier, carrier])
			return op === undefined ? [] : [op.id]
		})
		if (equality.length !== node.heading.length) {
			return false
		}
		const unique = keyedBy(
			cx.physical().of(node.left).props,
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
		ed.set(cell, {
			kind: node.kind === "Intersect" ? "SemiJoin" : "AntiJoin",
			left: node.left,
			right: node.right,
			on,
			heading: node.heading,
			meta: node.meta,
			loc: node.loc
		})
		return true
	}
}

const existencePotential: Potential = (cx) => {
	let count = 0
	for (const cell of cx.editor.topoOrder()) {
		const node = cell.current
		if (node.kind === "MatchRegion") {
			count += existenceOnly(cx, cell, node).length
		}
		if (node.kind === "Intersect" || node.kind === "Difference") {
			count++
		}
	}
	return count
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
 * witness per parent with the least work and keep the planning problem one PostgreSQL can
 * flatten. Three conditions decide it, each structural and deterministic:
 *
 * - No cross join. The occurrence's removal must not split the remaining occurrences into more groups than the region
 *   already has, where two occurrences are joined when they bind one variable (or variables a region equality makes
 *   equal). An occurrence that connects two others, the interior of a chain or the Task between Account and Note, is a
 *   join edge: as a semi-join it would leave its neighbours in one FROM list with no condition between them, joined
 *   only by the EXISTS above, which PostgreSQL reconnects only within its collapse limits. A join without a condition
 *   appears only where the query has one.
 * - Witness multiplicity first. An occurrence whose bound and constant columns determine a physical key of its source
 *   has at most one witness per binding of the others, so a semi-join consumes no fewer rows than the join it replaces;
 *   one without such a key can have many, and is the existence test that saves work. Unkeyed candidates are taken
 *   before keyed ones, each group in the region's occurrence order. The key decides only the choice, never the rewrite's
 *   validity, so it is no premise of the certificate.
 * - Bounded nesting. Each rewrite stacks one more semi-join over the region; PostgreSQL flattens a semi-join into its
 *   input's join problem only while their relations number at most join_collapse_limit, and plans the rest as separate
 *   subproblems in the order written, so an EXISTS past the limit is applied only after everything below it has been
 *   joined (a twelve-edge path whose start match became an EXISTS joins the other eleven edges unrestricted). The rewrite
 *   is admitted only while the region's occurrences and the relations of the semi- and anti-joins already stacked over
 *   it stay within that limit; past it the region stays one flat join PostgreSQL orders itself. grizzle never changes the
 *   limit, so the bound is PostgreSQL's default.
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
