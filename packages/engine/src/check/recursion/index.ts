import type { RecursionPlugin } from "#compiler/check/context.ts"
import { only as onlyMember } from "#compiler/check/defined.ts"
import { counterDepth, counterInterval, reachable } from "#compiler/check/recursion/bound.ts"
import { factorArms } from "#compiler/check/recursion/factor.ts"
import { carryOrigin, correlationColumns, originParents } from "#compiler/check/recursion/origin.ts"
import { scanArms } from "#compiler/check/recursion/scan.ts"
import { conform, declaredRow, requireHashing } from "#compiler/check/recursion/state.ts"
import { terminationCertificate } from "#compiler/check/recursion/termination.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { recursionMaxStates } from "#compiler/core/policy.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import type { Heading } from "#compiler/ir/rel.ts"

/** The location of a list's one member, or `fallback` for a list of none or several. */
const only = (list: ReadonlyArray<{ readonly loc: SourceLoc }>, fallback: SourceLoc): SourceLoc =>
	onlyMember(list)?.loc ?? fallback

/**
 * Recursion admission: query(S).recursive(name, { row, base, rec }) to a checked Recursive node.
 *
 * The checker dispatches a recursive stage here (context.ts). Admission checks, in this order:
 *
 * 1. Structure (scan.ts): every arm delivers exactly the declared row; a recursive arm reads `self` at most once, never
 *    negates it and never aggregates over it; no approximate source feeds the recursion; no arm carries an attachment.
 *    A recursive arm that reads no `self` joins the base.
 * 2. The state (state.ts): the declared row's types, each with the hashing capability a recursive UNION needs.
 * 3. The base: its arms are checked as one stage, their union. In an attachment's child the checker delivers the
 *    correlation columns beside every arm's head; those columns are part of the state, at the types the
 *    base delivers them, and they are the recursion's origin: the originating parent, carried in the deduplicated
 *    state, so the traversals of different parents never merge. A correlation
 *    column the checker names after a head key, because that key delivers the parent variable unchanged, is a declared
 *    row column and part of the origin as well.
 * 4. The step: a SelfRef over the state heading, read by the recursive arms. One arm is checked as it is; several are
 *    factored into one rule that reads `self` once (factor.ts). In an attachment's child the step's
 *    `self` match also binds each origin column to its parent variable, so every state carries the parent of the
 *    seed it came from instead of reading the outer parent (origin.ts).
 * 5. Conformance (state.ts): base and step deliver the state at its declared types, through exact casts where needed.
 * 6. Termination (termination.ts): the certificate family and the static seen-state estimate, refused above the
 *    recursionMaxStates (core/policy.ts) with ResourceBound.
 *
 * A recursion whose arms read no `self` at all is its base: the least fixed point of a constant step is the step's
 * union with the base, so no Recursive node is built.
 *
 * Every refusal is a RecursionRefused at the arm or clause that causes it, its cause a RecursionRefusal
 * (core/causes.ts) naming the rule; a state estimate above the bound is its ResourceBound stateEstimate.
 */
export const recursion: RecursionPlugin = {
	check: (stage, scope, loc, cx) => {
		const def = stage.recursive
		const at = childLoc(loc, "recursive")
		const arms = scanArms(def)
		const row = declaredRow(def, at, cx)
		const baseLoc = childLoc(at, "base")
		const recLoc = childLoc(at, "rec")

		const baseNode = cx.arms(
			mapNonEmpty(arms.base, (a) => a.rule),
			scope,
			baseLoc,
			undefined
		)
		/**
		 * The state heading in the base's column order: the declared row at its declared types, then any correlation
		 * column the checker delivers in an attachment's child, at the base's type.
		 */
		const state: Heading = baseNode.heading.map((c) => {
			const declared = row.get(c.name)
			if (declared !== undefined) {
				return { name: c.name, type: declared }
			}
			requireHashing(def.name, c.name, c.type, baseLoc)
			return { name: c.name, type: c.type }
		})
		/**
		 * The origin: every correlation column, the ones the checker delivers beside the head and the ones a head key
		 * delivers as the parent variable unchanged, which are declared row columns. Either way each recursive arm carries
		 * it from the state it extends rather than reading the outer parent.
		 */
		const correlation = correlationColumns(stage)
		const origin = state
			.filter((c) => !row.has(c.name) || correlation.has(c.name))
			.map((c) => c.name)
		const base = conform(cx, def.name, baseNode, state, "base", only(arms.base, baseLoc), new Map())
		const { rec } = arms
		if (!isNonEmpty(rec)) {
			return base
		}

		const recursive = cx.reserve()
		const self = cx.node({ kind: "SelfRef", recursive, heading: state }, recLoc)
		const stepRule = carryOrigin(
			onlyMember(rec)?.rule ?? factorArms(rec, [...row.keys()], at),
			originParents(stage, origin, baseLoc)
		)
		const stepNode = cx.arms([stepRule], scope, recLoc, self)
		const step = conform(
			cx,
			def.name,
			stepNode,
			state,
			"rec",
			only(rec, recLoc),
			stateCounters(base, stepNode, self, state)
		)
		const termination = terminationCertificate({
			def,
			row,
			base: arms.base,
			rec,
			step,
			maxStates: recursionMaxStates,
			loc,
			cx
		})
		return cx.define(
			recursive,
			{ kind: "Recursive", name: def.name, base, step, self, termination, origin, heading: state },
			loc
		)
	}
}

/**
 * The interval every bounded counter of a recursion's state computes, by state column (bound.ts counterInterval): what
 * proves an exact step `c + k` fits the column it narrows into, with no guard of the author's.
 */
const stateCounters = (
	base: RelNode,
	step: RelNode,
	self: RelNode,
	state: Heading
): ReadonlyMap<string, readonly [bigint, bigint]> => {
	const labels = new Map(reachable([base, step]).map((n) => [n.id, n] as const))
	const parts = { base, step, self, heading: state }
	const out = new Map<string, readonly [bigint, bigint]>()
	for (const c of state) {
		const analysis = counterDepth(labels, parts, c.name)
		if (analysis.kind === "bounded") {
			out.set(c.name, counterInterval(analysis.proof))
		}
	}
	return out
}
