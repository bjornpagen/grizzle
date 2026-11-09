import type { NodeId, VarId } from "#compiler/core/ids.ts"
import { localCertificate } from "#compiler/ir/certificate.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Cell, EditRefs, KindOver, OccurrenceOver, VarDecl } from "#compiler/ir/rel.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import { columnRefs, DagEditor, derivedMeta } from "#compiler/lower/optimize/demand/editor.ts"

import {
	type Potential,
	type RewriteCx,
	type Rule,
	rewritePass
} from "#compiler/lower/optimize/demand/frame.ts"
import { type RegionChain, regionChain } from "#compiler/lower/optimize/fuse/chain.ts"
import { conjunction } from "#compiler/lower/optimize/simplify/boolean.ts"

const fusionRule = "R01.fusion"

type Region = KindOver<"MatchRegion", EditRefs>
type Occurrence = OccurrenceOver<Cell, ScalarExpr, VarDecl>

/** The names of the inner variables the chain's predicates read. */
const predicateVars = (chain: RegionChain): ReadonlySet<string> =>
	new Set(
		chain.preds.flatMap((p) =>
			columnRefs([p.pred]).flatMap((ref) => {
				const v = p.columns.get(ref.name)
				return v === undefined ? [] : [v.name]
			})
		)
	)

/** Whether the region `cell` holds may absorb the chain under its occurrence `o`. */
const fusable = (cx: RewriteCx, cell: Cell, o: Occurrence, chain: RegionChain): boolean => {
	const ed = cx.editor
	const inner = chain.region
	if (chain.regionCell === cell || inner.correlated.length > 0) {
		return false
	}
	if (ed.readsFeedback(cell)) {
		return false
	}
	const d = cx.demand()
	const quiet = (c: Cell) => !d.lateral(c)
	if (![...chain.nodes, chain.regionCell, ...inner.occurrences.map((x) => x.source)].every(quiet)) {
		return false
	}
	if (![...chain.nodes, chain.regionCell].every((c) => d.references(c) === 1)) {
		return false
	}
	if (ed.correlated(o.source)) {
		return false
	}
	if (columnRefs(inner.occurrences.flatMap((x) => x.constants.map((c) => c.expr))).length > 0) {
		return false
	}
	const innerOf = (column: string) => chain.columns.get(column)?.name
	const predVars = predicateVars(chain)
	const equated = new Set(inner.equalities.flatMap((e) => [e.a.name, e.b.name]))
	/**
	 * Each inner variable fixed at most once: two columns carrying one inner variable and fixed to two expressions
	 * state that the expressions are equal, a condition the fused region would lose.
	 */
	const fixed = new Set<string>()
	for (const c of o.constants) {
		const x = innerOf(c.column)
		if (x === undefined || fixed.has(x)) {
			return false
		}
		fixed.add(x)
		if (o.bindings.some((b) => innerOf(b.column) === x)) {
			return false
		}
		if (equated.has(x)) {
			return false
		}
		if (predVars.has(x) && columnRefs([c.expr]).length > 0) {
			return false
		}
	}
	return o.bindings.every((b) => innerOf(b.column) !== undefined)
}

/** The candidates of the region `cell` holds: its occurrences over a fusable chain. */
const candidates = (
	cx: RewriteCx,
	cell: Cell,
	region: Region
): ReadonlyArray<{ readonly o: Occurrence; readonly chain: RegionChain }> =>
	region.occurrences.flatMap((o) => {
		const chain = regionChain(o.source)
		return chain !== undefined && fusable(cx, cell, o, chain) ? [{ o, chain }] : []
	})

type Image =
	| { readonly kind: "var"; readonly v: VarDecl }
	| { readonly kind: "const"; readonly e: ScalarExpr }
	| { readonly kind: "exist" }

/** A variable whose image is existential leaves its column unbound: an existential witness. */
const fuse = (
	cx: RewriteCx,
	cell: Cell,
	region: Region,
	o: Occurrence,
	chain: RegionChain
): void => {
	const ed: DagEditor = cx.editor
	const inner = chain.region
	const image = new Map<VarId, Image>()
	/**
	 * The inner variable a column of a chain node carries: every column of the chain carries one of the region's
	 * variables (regionChain), and fusable() admits only such chains.
	 */
	const innerVar = (column: string): VarDecl => columnIn(chain.columns, column)
	const extraEqualities: Array<{ readonly a: VarDecl; readonly b: VarDecl }> = []
	for (const b of o.bindings) {
		const x = innerVar(b.column)
		const v = b.var
		const prior = image.get(x.id)
		if (prior?.kind !== "var") {
			image.set(x.id, { kind: "var", v })
			continue
		}
		if (prior.v.id !== v.id) {
			extraEqualities.push({ a: prior.v, b: v })
		}
	}
	for (const c of o.constants) {
		const x = innerVar(c.column)
		image.set(x.id, { kind: "const", e: c.expr })
	}
	/** Inner variables that must stay variables: joins, equalities, predicate operands. */
	const bindingCount = new Map<VarId, number>()
	for (const io of inner.occurrences) {
		for (const b of io.bindings) {
			bindingCount.set(b.var.id, (bindingCount.get(b.var.id) ?? 0) + 1)
		}
	}
	const predVars = predicateVars(chain)
	const equated = new Set(inner.equalities.flatMap((e) => [e.a.id, e.b.id]))
	const names = new Set(region.vars.map((v) => v.name))
	const hidden: Array<VarDecl> = []
	/**
	 * What an inner variable becomes: its image from the occurrence, else an existential witness where only one binding
	 * reads it, else a fresh hidden variable. Each inner variable gets its image once, in declared order.
	 */
	const imageOf = (x: VarDecl): Image => {
		const known = image.get(x.id)
		if (known !== undefined) {
			return known
		}
		const live = (bindingCount.get(x.id) ?? 0) !== 1 || predVars.has(x.name) || equated.has(x.id)
		if (!live) {
			const exist: Image = { kind: "exist" }
			image.set(x.id, exist)
			return exist
		}
		const h: VarDecl = { id: ed.freshVar(), name: DagEditor.freshName(names, x.name), type: x.type }
		hidden.push(h)
		const img: Image = { kind: "var", v: h }
		image.set(x.id, img)
		return img
	}
	for (const x of inner.vars) {
		imageOf(x)
	}
	/** The inner occurrences, copied: fresh occurrence ids, a stored source rescanned under a fresh occurrence. */
	const copies: Array<Occurrence> = []
	for (const io of inner.occurrences) {
		const id = ed.freshOccurrence()
		const source = io.source.current
		const src = source.kind === "Base" ? ed.rescan(source) : io.source
		const images = io.bindings.map((b) => ({ column: b.column, img: imageOf(b.var) }))
		const bindings = images.flatMap(({ column, img }) =>
			img.kind === "var" ? [{ column, var: img.v }] : []
		)
		const constants = [
			...io.constants,
			...images.flatMap(({ column, img }) =>
				img.kind === "const" ? [{ column, expr: img.e }] : []
			)
		]
		copies.push({ id, source: src, bindings, constants })
	}
	const equalities = [...region.equalities]
	const pushEquality = (a: VarDecl, b: VarDecl) => {
		if (a.id === b.id) {
			return
		}
		if (
			equalities.some(
				(e) => (e.a.id === a.id && e.b.id === b.id) || (e.a.id === b.id && e.b.id === a.id)
			)
		) {
			return
		}
		equalities.push({ a, b })
	}
	for (const e of inner.equalities) {
		const a = image.get(e.a.id)
		const b = image.get(e.b.id)
		if (a?.kind === "var" && b?.kind === "var") {
			pushEquality(a.v, b.v)
		}
	}
	for (const e of extraEqualities) {
		pushEquality(e.a, e.b)
	}
	const fused: Region = {
		...region,
		vars: [...region.vars, ...hidden],
		occurrences: [...region.occurrences.filter((x) => x.id !== o.id), ...copies],
		equalities,
		heading: [...region.heading, ...hidden.map((h) => ({ name: h.name, type: h.type }))]
	}
	const original = region
	const widened = hidden.length > 0 || chain.preds.length > 0
	ed.set(cell, widened ? { ...fused, meta: derivedMeta(original.meta) } : fused)
	/** The chain's predicates over R's variables. */
	const preds = chain.preds.map((p) =>
		ed.copyExpr(p.pred, (ref) => {
			if (ref.node !== p.over.id) {
				return undefined
			}
			const img = imageOf(columnIn(p.columns, ref.name))
			if (img.kind === "const") {
				return img.e
			}
			if (img.kind === "var") {
				return ed.column(cell, img.v)
			}
			return undefined
		})
	)
	const outputs: Array<NodeId> = [cell.id]
	if (widened) {
		ed.insertAbove(cell, (rid) => {
			let top = rid
			const [first] = preds
			if (first !== undefined) {
				top = ed.add({
					kind: "Filter",
					input: rid,
					pred: conjunction(ed, preds, first),
					heading: fused.heading,
					meta: hidden.length > 0 ? derivedMeta(original.meta) : original.meta,
					loc: undefined
				})
				outputs.push(top.id)
			}
			if (hidden.length > 0) {
				const input = top
				top = ed.add({
					kind: "ProjectSet",
					input,
					out: original.heading.map((c) => ({ name: c.name, expr: ed.column(input, c) })),
					heading: original.heading,
					meta: original.meta,
					loc: undefined
				})
				outputs.push(top.id)
			}
			return top
		})
	}
	cx.certify(
		localCertificate(
			fusionRule,
			[...chain.nodes.map((c) => c.id), chain.regionCell.id],
			outputs,
			[o.source.id],
			original.heading.map((c) => c.name)
		)
	)
}

const fuseRule: Rule = {
	name: fusionRule,
	at: (cell, cx) => {
		const node = cell.current
		if (node.kind !== "MatchRegion") {
			return false
		}
		const first = candidates(cx, cell, node)[0]
		if (first === undefined) {
			return false
		}
		fuse(cx, cell, node, first.o, first.chain)
		return true
	}
}

/**
 * The fusion potential: the reachable regions. Fusing an occurrence over a chain copies the chain's region's
 * occurrences into the fused region, which keeps its cell, and leaves the chain read by nothing, since fusable()
 * admits only a chain every node of which the occurrence alone references; the filter and the rename fusion may place
 * above the fused region are no regions. So each fusion removes exactly one region and adds none.
 */
const fusionPotential: Potential = (cx) =>
	cx.editor.topoOrder().filter((cell) => cell.current.kind === "MatchRegion").length

/**
 * The R01 pass.
 *
 * R01: fuse match regions and preserve true semantic boundaries.
 *
 * Pattern: an occurrence of a region R whose source is a region chain (chain.ts), an imported query or a stage written
 * as several builder calls, with no group, take, recursion or approximate boundary in it. The chain's set is
 * pi(sigma_p(I)) for its region I; matching it in R binds or fixes some of its columns and leaves the rest
 * existential. Fusion inlines I's occurrences into R:
 *
 * - an inner variable a column of the chain carries is renamed to the outer variable R binds that column to, or fixed
 *   to the expression R fixes it to; two columns carrying one inner variable and bound to two outer variables equate
 *   them;
 * - an inner variable R does not see is existential when nothing else needs it, and otherwise (a join between inner
 *   occurrences, an inner equality, a predicate) a fresh hidden variable of R;
 * - every predicate of the chain becomes a predicate over R's variables, in one Filter over the fused region, and when
 *   hidden variables widened R a projection onto R's original heading restores the set R denoted.
 *
 * R's readers then see one direct region, which the lowering emits as one SELECT with every join and predicate, and
 * the duplicate elimination the chain's projection owed moves to the single set boundary above R, where dedup
 * placement proves it redundant or keeps it ("unknown uniqueness retains exact deduplication").
 *
 * The certificate records what fusion must preserve: the complete bound tuple and projection equality
 * (the preserved heading is R's original one, restored by the projection), refined parameter validation (no
 * expression is cast or moved across a write), the evidence context (fusion uses no evidence: queryLocal), and every
 * aggregate, limit and recursive boundary (a chain contains none, and a region on a recursive step is not touched).
 *
 * Refused when moving would change scope: a correlated chain, a chain node or source some expression reads laterally,
 * a correlated inner region, or a fixed column whose variable a predicate reads through a non-constant expression. Refused too when
 * two columns carrying one inner variable are fixed, or one fixed and one bound: the occurrence then also requires the
 * two values to be equal, which the substitution of one image per inner variable cannot state. And refused for a chain
 * another reference also reads: fusing it would copy it into each reader, so the program would grow with the paths
 * through it rather than with its nodes; it stays one shared stage, which the CTE policy places.
 *
 * Potential: the reachable regions (fusionPotential), which each fusion lowers by one. The number of fusable
 * occurrences alone would not fall, because a copy can fuse where its original could not: a column the original bound
 * and the outer region leaves existential no longer conflicts with a fixed column carrying the same inner variable;
 * but every fusion consumes the region it inlines.
 */
export const fusePass = rewritePass({
	name: "fuse",
	rules: [fuseRule],
	potential: () => fusionPotential
})
