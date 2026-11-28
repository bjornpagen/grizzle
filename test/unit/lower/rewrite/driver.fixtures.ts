/** What the properties of driver.test.ts read: their spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { makeCertificate } from "#compiler/ir/certificate.ts"
import type { PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type Cell,
	conservativeMeta,
	type EditNode,
	edgesOf,
	type RelNode
} from "#compiler/ir/rel.ts"
import { DagEditor } from "#compiler/lower/optimize/demand/editor.ts"
import {
	type Potential,
	type RewriteCx,
	type Rule,
	traversalPass
} from "#compiler/lower/optimize/demand/frame.ts"
import { allenNormalForm, simplificationRules } from "#compiler/lower/optimize/simplify/rules.ts"
import { succeeded } from "#test/support/assert.ts"
import type { CountedFunction } from "#test/support/kernel/coverage.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { Posting, Q, T } from "#test/support/unit/lower/conservative/fixtures.ts"

/**
 * The cells `roots` reach in the order a walk of them visits them, as ir/dag.ts topoOrder walks a DAG: from each root in
 * order, depth first over each cell's edges in order, a cell ending after the cells first reached through it, a cell
 * reached again, or met again while its walk is open, followed no further. A second implementation of the editor's
 * kept order, which walks nothing again that an edit left alone.
 */
export const walkOf = (roots: ReadonlyArray<Cell>): ReadonlyArray<Cell> => {
	const order: Array<Cell> = []
	const seen = new Set<Cell>()
	for (const root of roots) {
		if (seen.has(root)) {
			continue
		}
		seen.add(root)
		const stack = [{ cell: root, edges: edgesOf(root.current), next: 0 }]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const input = frame.edges[frame.next]
			if (input === undefined) {
				stack.pop()
				order.push(frame.cell)
				continue
			}
			frame.next++
			if (!seen.has(input)) {
				seen.add(input)
				stack.push({ cell: input, edges: edgesOf(input.current), next: 0 })
			}
		}
	}
	return order
}

/** One edit the order property makes, at the reached cells its indices pick, by kind, and whether a state follows it. */
export interface OrderEdit {
	readonly at: number
	readonly other: number
	readonly kind:
		| "redirected to a copy"
		| "emptied"
		| "restored"
		| "took another's node"
		| "redirected to another"
		| "made a cycle"
	readonly next: "a state taken" | "another edit first"
}

/** Up to ten edits, each at cells its indices pick among the cells reached when it is made. */
export const orderEdits: Gen<ReadonlyArray<OrderEdit>> = array(
	(s) => ({
		at: s.draw(int(0, 1000)),
		other: s.draw(int(0, 1000)),
		kind: s.draw(
			element([
				"redirected to a copy",
				"emptied",
				"restored",
				"took another's node",
				"redirected to another",
				"made a cycle"
			] as const)
		),
		next: s.draw(element(["a state taken", "another edit first"] as const))
	}),
	{ min: 1, max: 10 }
)

/** What the order property reaches. */
export type OrderFeature =
	| "a kept segment moved"
	| "a cell left the order"
	| "a cell joined the order"
	| "several cells changed before a state"
	| "a root moved"
	| "a cycle"

/**
 * `edit` made at the cells reached now, `emptied` the cells an edit emptied and the nodes they held: what it reached, or
 * nothing where the cells give it no place (no other cell to take, none of the cells' own descendants). A redirection
 * picks among the cells several references read where there are any, so it changes several readers at once.
 */
export const editOrder = (
	editor: DagEditor,
	edit: OrderEdit,
	emptied: Map<Cell, EditNode>
): ReadonlyArray<OrderFeature> => {
	const order = editor.topoOrder()
	const state = editor.cellState()
	const shared = Arr.filter(order, (c) => state.references(c) > 1)
	const among =
		(edit.kind === "redirected to a copy" || edit.kind === "redirected to another") &&
		shared.length > 0
			? shared
			: order
	const cell = defined(among[edit.at % among.length], "a reached cell")
	const other = defined(order[edit.other % order.length], "a reached cell")
	const rootsBefore = editor.roots
	const reaches = (from: Cell, to: Cell): boolean => DagEditor.subtree(from).has(to)
	switch (edit.kind) {
		case "redirected to a copy": {
			editor.redirect(cell, editor.add(cell.current))
			break
		}
		case "emptied": {
			emptied.set(cell, cell.current)
			editor.set(cell, {
				kind: "Closed",
				closed: "_order",
				rows: [],
				heading: cell.current.heading,
				meta: cell.current.meta,
				loc: cell.current.loc
			})
			break
		}
		case "restored": {
			const [back] = emptied
			if (back === undefined) {
				return []
			}
			emptied.delete(back[0])
			editor.set(back[0], back[1])
			break
		}
		case "took another's node": {
			if (other === cell || reaches(other, cell)) {
				return []
			}
			editor.set(cell, other.current)
			break
		}
		case "redirected to another": {
			if (other === cell || reaches(other, cell)) {
				return []
			}
			editor.redirect(cell, other)
			break
		}
		case "made a cycle": {
			const below = Arr.filter([...DagEditor.subtree(cell)], (c) => c !== cell)
			const into = below[edit.other % Math.max(1, below.length)]
			if (into === undefined) {
				return []
			}
			editor.set(into, cell.current)
			return ["a cycle"]
		}
	}
	return Arr.some(rootsBefore, (root, i) => root !== editor.roots[i]) ? ["a root moved"] : []
}

/** What changed between two orders of one editor's cells: cells that left, cells that joined, a pair that swapped. */
export const orderMoves = (
	before: ReadonlyArray<Cell>,
	after: ReadonlyArray<Cell>
): ReadonlyArray<OrderFeature> => {
	const was = new Map(Arr.map(before, (c, i) => [c, i] as const))
	const now = new Set(after)
	const kept = Arr.flatMap(after, (c) => {
		const at = was.get(c)
		return at === undefined ? [] : [at]
	})
	return [
		...(Arr.some(before, (c) => !now.has(c)) ? ["a cell left the order" as const] : []),
		...(kept.length < after.length ? ["a cell joined the order" as const] : []),
		...(Arr.some(kept, (at, i) => i > 0 && at < defined(kept[i - 1], "the place before"))
			? ["a kept segment moved" as const]
			: [])
	]
}

/** How a node of a shared DAG (sharedDags) is built over the nodes built before it. */
type SharedNode =
	| "a new region over postings"
	| "a filter"
	| "a projection"
	| "a region of one"
	| "a join"
	| "a union"
	| "a diamond"

/**
 * Small DAGs that share their nodes, each over every posting: between 3 and 24 nodes, each a new region over postings
 * or a filter, a projection, a region of one occurrence, a join (a region of two occurrences on both columns), a
 * union, or a diamond (a join of a node and a region over a filter over it, which reads the node at two depths) over
 * nodes built before it, each picked anew, half the time among the last three built and half among them all, so chains
 * grow and a node is read by any number of later ones; every node delivers a posting's id and account.
 * Its roots are its last node and, where drawn, one before it.
 */
export const sharedDags: Gen<LogicalQuery> = (s) => {
	const q = new Q()
	const leaf = (): RelNode =>
		q.region([
			{
				source: q.base(Posting, conservativeMeta),
				bind: { id: "id", account: "account" },
				constants: {}
			}
		])
	const of = (source: RelNode) => ({
		source,
		bind: { id: "id", account: "account" },
		constants: {}
	})
	const built: Array<RelNode> = [leaf()]
	const pick = (): RelNode =>
		defined(
			s.draw(int(0, 1)) === 0
				? built.at(-1 - s.draw(int(0, Math.min(2, built.length - 1))))
				: built[s.draw(int(0, built.length - 1))],
			"a node built before"
		)
	const count = s.draw(int(2, 23))
	for (let i = 0; i < count; i++) {
		const kind: SharedNode = s.draw(
			element([
				"a new region over postings",
				"a filter",
				"a projection",
				"a region of one",
				"a join",
				"a union",
				"a diamond"
			] as const)
		)
		switch (kind) {
			case "a new region over postings":
				built.push(leaf())
				break
			case "a filter": {
				const input = pick()
				built.push(q.filter(input, q.lit({ kind: "bool", value: true }, T.bool)))
				break
			}
			case "a projection":
				built.push(
					q.project(
						pick(),
						[
							["id", "id"],
							["account", "account"]
						],
						conservativeMeta
					)
				)
				break
			case "a region of one":
				built.push(q.region([of(pick())]))
				break
			case "a join":
				built.push(q.region([of(pick()), of(pick())]))
				break
			case "a union":
				built.push(q.union([pick(), pick()], []))
				break
			case "a diamond": {
				const below = pick()
				const chain = q.region([of(q.filter(below, q.lit({ kind: "bool", value: true }, T.bool)))])
				built.push(chain, q.region([of(chain), of(below)]))
				break
			}
		}
	}
	const last = defined(built.at(-1), "the last node")
	const roots = s.draw(int(0, 1)) === 1 && built.length > 1 ? [last, pick()] : [last]
	return { dag: q.b.build(nonEmptyList(roots, "the roots")), params: [] }
}

/** Which wake a gadget (wakeGadget) needs to fire as a scan of every cell does. */
export type Wake =
	| "a filter beneath a join that empties"
	| "a sibling that empties"
	| "a projection that draws before a firing"

/**
 * A union of two arms over postings, built so that a quiet cell must wake for the driver to fire as a scan does:
 *
 * - `a filter beneath a join that empties`: the first arm a region of one over a filter over a region `j`, the second a
 *   join of `j` and a filter over a region of its own. The second arm's filter empties first (`alone`), then the join
 *   over it (`over an empty input`), which leaves the first arm's filter the one reader of `j`, a reach it heard
 *   quiet, so it empties (`alone`), and the region over it, quiet since the first state, must hear that its own subtree
 *   changed (`over an empty input`);
 * - `a sibling that empties`: the first arm a region of one over a region, the second a filter over a region of its own,
 *   which empties first (`alone`); the first arm, quiet since the first state, must hear that its reader's other input
 *   changed (`beside an empty sibling`), or the union empties it (`a union empties its first arm`);
 * - `a projection that draws before a firing`: the first arm a projection, which draws a label at every state that
 *   judges it (`draws and holds`), the second a filter that empties first (`alone`), after which the union empties the
 *   first arm (`a union empties its first arm`) under a label drawn after the projection's.
 */
export const wakeGadget = (wake: Wake): LogicalQuery => {
	const q = new Q()
	const leaf = (): RelNode =>
		q.region([
			{
				source: q.base(Posting, conservativeMeta),
				bind: { id: "id", account: "account" },
				constants: {}
			}
		])
	const of = (source: RelNode) => ({
		source,
		bind: { id: "id", account: "account" },
		constants: {}
	})
	const holds = () => q.lit({ kind: "bool", value: true }, T.bool)
	switch (wake) {
		case "a filter beneath a join that empties": {
			const j = leaf()
			const first = q.region([of(q.filter(j, holds()))])
			const second = q.region([of(j), of(q.filter(leaf(), holds()))])
			return {
				dag: q.b.build(nonEmptyList([q.union([first, second], [])], "the roots")),
				params: []
			}
		}
		case "a sibling that empties": {
			const first = q.region([of(leaf())])
			const second = q.filter(leaf(), holds())
			return {
				dag: q.b.build(nonEmptyList([q.union([first, second], [])], "the roots")),
				params: []
			}
		}
		case "a projection that draws before a firing": {
			const first = q.project(
				leaf(),
				[
					["id", "id"],
					["account", "account"]
				],
				conservativeMeta
			)
			const second = q.filter(leaf(), holds())
			return {
				dag: q.b.build(nonEmptyList([q.union([first, second], [])], "the roots")),
				params: []
			}
		}
	}
}

/** The gadgets' wakes, the roster a box draws from. */
export const wakes: ReadonlyArray<Wake> = Object.freeze([
	"a filter beneath a join that empties",
	"a sibling that empties",
	"a projection that draws before a firing"
] as const)

/**
 * A chain of `regions` regions, the first over every posting and each next over the one below it, under `filters`
 * filters that always hold, the top one the query's root: simplification folds each filter into the region below it,
 * the innermost first, one at a time, each fold leaving every region as it was.
 */
export const foldChain = (regions: number, filters: number): LogicalQuery => {
	const q = new Q()
	const over = (source: RelNode): RelNode =>
		q.region([{ source, bind: { id: "id", account: "account" }, constants: {} }])
	let at = over(q.base(Posting, conservativeMeta))
	for (let i = 1; i < regions; i++) {
		at = over(at)
	}
	for (let i = 0; i < filters; i++) {
		at = q.filter(at, q.lit({ kind: "bool", value: true }, T.bool))
	}
	return { dag: q.b.build(nonEmptyList([at], "the roots")), params: [] }
}

/**
 * What the work property counts: each verdict a simplification rule takes at a cell (simplify/rules.ts, every rule's
 * `at`), and each cell's kept shape the editor reads (editor.ts #entryOf), which every walk of the cells reads once a
 * cell it reaches and a patch of the kept order once a cell it walks.
 */
export const workSites = Object.freeze({
	verdicts: { file: "packages/engine/src/lower/optimize/simplify/rules.ts", name: "at" },
	shapes: { file: "packages/engine/src/lower/optimize/demand/editor.ts", name: "#entryOf" }
} satisfies Readonly<Record<string, CountedFunction>>)

/**
 * `query` rewritten by `rules` as the driver before the quiet cells ran a pass, a second implementation of frame.ts
 * rewritePass for rules that ask no decision: at every state of the cells, a scan of every cell in order from the
 * first, every rule read at each cell that reads no recursion's feedback, the first that fires applied, until none
 * fires. Its certificates go to `ctx`.
 */
export const scanned = (
	rules: ReadonlyArray<Rule>,
	name: string,
	query: LogicalQuery,
	ctx: PassContext
): LogicalQuery => {
	const editor = new DagEditor(query.dag)
	const cxOf = (): RewriteCx => ({
		editor,
		ctx,
		pass: name,
		catalog: ctx.catalog,
		cells: editor.cellState(),
		certify: (input) => {
			ctx.certificates.record(succeeded(makeCertificate(input)))
		}
	})
	/** The state's first firing, the rule's verdict at each cell read in order; whether one fired. */
	const fires = (cx: RewriteCx): boolean => {
		for (const cell of cx.cells.order) {
			if (cx.cells.feedback.has(cell)) {
				continue
			}
			for (const rule of rules) {
				const verdict = rule.at(cell, cx)
				assert.ok(typeof verdict === "boolean", "a verdict that asks no decision")
				if (verdict) {
					return true
				}
			}
		}
		return false
	}
	while (fires(cxOf())) {
		assert.ok(editor.version > 0, "a firing edits")
	}
	return editor.version === 0 ? query : { ...query, dag: editor.finish() }
}

/** The semantic simplification of `query` as the driver before the quiet cells ran it: the Allen normal form, then scanned. */
export const scannedSimplification = (query: LogicalQuery, ctx: PassContext): LogicalQuery =>
	scanned(
		simplificationRules,
		"simplify",
		succeeded(traversalPass({ name: "simplify", step: allenNormalForm }).run(query, ctx)),
		ctx
	)

/**
 * A cell made the empty relation of its heading, its metadata kept, under a closed name that holds a fresh label, so a
 * DAG's empty relations show every label the pass drew before them.
 */
const emptied = (cx: RewriteCx, cell: Cell): true => {
	const node = cell.current
	cx.editor.set(cell, {
		kind: "Closed",
		closed: `_toy_${cx.editor.freshVar()}`,
		rows: [],
		heading: node.heading,
		meta: node.meta,
		loc: node.loc
	})
	return true
}

const isEmpty = (cell: Cell): boolean =>
	cell.current.kind === "Closed" && cell.current.rows.length === 0

/**
 * The toy rules a driver property's passes draw from, each reading the cells one way the driver must hear (Reads), and
 * firing only by emptying a cell (emptied), the one it judges but for the union's:
 *
 * - `alone`: a filter whose input one reference reads and no root stands at: its input's reach;
 * - `over an empty input`: a cell one of whose inputs is empty: the nodes of its subtree;
 * - `beside an empty sibling`: a cell another input of one of whose readers is empty: its readers and their subtrees;
 * - `a union empties its first arm`: a union whose second arm is empty empties its first, a cell below it, which
 *   another reader may read: its subtree, and an edit below the cell it judges;
 * - `draws and holds`: a projection draws a fresh label and settles false, every time it is judged.
 */
export const toyRules = {
	alone: {
		name: "toy.alone",
		at: (cell, cx) =>
			cell.current.kind === "Filter" &&
			cx.cells.references(cell.current.input) === 1 &&
			!cx.editor.isRoot(cell.current.input) &&
			emptied(cx, cell)
	},
	"over an empty input": {
		name: "toy.overEmpty",
		at: (cell, cx) =>
			!isEmpty(cell) && Arr.some(edgesOf(cell.current), isEmpty) && emptied(cx, cell)
	},
	"beside an empty sibling": {
		name: "toy.besideEmpty",
		at: (cell, cx) =>
			!isEmpty(cell) &&
			Arr.some(cx.cells.readers(cell), (reader) =>
				Arr.some(edgesOf(reader.current), (e) => e !== cell && isEmpty(e))
			) &&
			emptied(cx, cell)
	},
	"a union empties its first arm": {
		name: "toy.firstArm",
		at: (cell, cx) => {
			const node = cell.current
			if (node.kind !== "Union") {
				return false
			}
			const [first, second] = Arr.flatMap(node.groups, (g) => g.arms)
			return second !== undefined && isEmpty(second) && !isEmpty(first) && emptied(cx, first)
		}
	},
	"draws and holds": {
		name: "toy.draws",
		at: (cell, cx) => {
			if (cell.current.kind === "ProjectSet") {
				cx.editor.freshVar()
			}
			return false
		}
	}
} as const satisfies Readonly<Record<string, Rule>>

/** A toy rule by its name (toyRules). */
export type ToyRule = keyof typeof toyRules

/** The toy rules' names, the roster a pass draws its rules from. */
export const toyRuleNames: ReadonlyArray<ToyRule> = Object.freeze([
	"alone",
	"over an empty input",
	"beside an empty sibling",
	"a union empties its first arm",
	"draws and holds"
] as const)

/** What the toy property reaches: a pass that emptied a cell, and one that emptied nothing. */
export type ToyFeature = "a pass that emptied a cell" | "a pass that emptied nothing"

/** The toy passes' potential: the reached cells not yet empty, which each firing lowers by the cell it empties at least. */
export const toyPotential = (): Potential => (cx) =>
	Arr.filter(cx.cells.order, (cell) => !isEmpty(cell)).length
