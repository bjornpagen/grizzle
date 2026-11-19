import { failRecursion } from "#compiler/check/fail.ts"
import type {
	ResolvedExpr,
	ResolvedHead,
	ResolvedMatch,
	ResolvedRecursive,
	ResolvedRule,
	ResolvedSource,
	ResolvedStage
} from "#compiler/check/params.ts"
import { entries } from "#compiler/check/scan.ts"
import type { RecursionArm } from "#compiler/core/causes.ts"
import { childLoc, locBelow, type SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { exprChildren } from "#compiler/ir/desc.ts"

/** One arm of the definition, with the location every refusal inside it names. */
export interface Arm {
	/** The arm's description, its location recorded on it so the checker names the arm's own path. */
	readonly rule: ResolvedRule
	readonly loc: SourceLoc
}

/**
 * A recursive arm that reads the feedback: an arm with its single `self` match and that match's index among its
 * matches.
 */
export interface RecArm extends Arm {
	readonly self: { readonly at: number; readonly match: ResolvedMatch }
}

interface ScannedArms {
	/** The base arms, then the recursive arms that read no `self`. */
	readonly base: NonEmptyReadonlyArray<Arm>
	/** The recursive arms that read `self`, each exactly once. */
	readonly rec: ReadonlyArray<RecArm>
}

/**
 * An arm at its rule's location, with every untyped head literal typed by its declared state column: a seed literal
 * takes the declared representation, never PostgreSQL's choice of a literal's type.
 */
const typedArm = (rule: ResolvedRule, row: ResolvedRecursive["row"]): Arm => {
	const head: Record<string, ResolvedHead> = {}
	for (const [key, h] of entries(rule.head)) {
		const declared = row[key]
		head[key] =
			h.kind === "literal" && h.type === undefined && declared !== undefined
				? { ...h, type: declared }
				: h
	}
	return { rule: { ...rule, head }, loc: rule.loc }
}

const where = (loc: SourceLoc, ...segments: ReadonlyArray<string | number>): SourceLoc =>
	segments.reduce<SourceLoc>((l, s) => childLoc(l, s), loc)

/** The relational filters, negations and existences, anywhere in an expression, with their structural locations. */
type Filtered = {
	readonly filter: Extract<ResolvedExpr, { readonly kind: "absent" | "exists" }>
	readonly loc: SourceLoc
}

const filters = (e: ResolvedExpr, loc: SourceLoc): ReadonlyArray<Filtered> => [
	...(e.kind === "absent" || e.kind === "exists" ? [{ filter: e, loc }] : []),
	...exprChildren(e).flatMap((c) => filters(c.term, locBelow(loc, c.at)))
]

/** Every source a rule reads in its own scope, its matches' and its relational filters', with their locations. */
const ownSources = (
	rule: ResolvedRule,
	loc: SourceLoc
): ReadonlyArray<{ readonly source: ResolvedSource; readonly loc: SourceLoc }> => [
	...rule.matches.map((m) => ({ source: m.source, loc: m.loc })),
	...rule.where.flatMap((e, i) =>
		filters(e, where(loc, "where", i)).map((f) => ({ source: f.filter.source, loc: f.loc }))
	)
]

/**
 * What lies below an arm, in the stages it imports and the interiors it describes: a `self` that names no definition
 * and an approximate source.
 */
class Nested {
	readonly name: string
	constructor(name: string) {
		this.name = name
	}

	rule(rule: ResolvedRule, loc: SourceLoc, top: boolean): void {
		for (const { source, loc: at } of ownSources(rule, loc)) {
			if (source.kind === "self" && !top) {
				failRecursion(at, { kind: "nestedSelf", recursion: this.name })
			}
			if (source.kind === "query" || source.kind === "step") {
				this.stage(source.query.stage)
			}
		}
		for (const interior of rule.interiors) {
			for (const arm of interior.arms) {
				this.rule(arm, arm.loc, false)
			}
		}
		for (const a of rule.attach) {
			this.stage(a.child.stage)
		}
	}

	/**
	 * An inner definition's own self belongs to it, and its own admission reads it; what it imports is still
	 * below this arm.
	 */
	stage(s: ResolvedStage): void {
		const here = s.kind === "attach" ? s.attach.loc : s.loc
		switch (s.kind) {
			case "rules":
				for (const r of s.arms) {
					this.rule(r, r.loc, false)
				}
				return
			case "union":
				this.stage(s.input)
				for (const r of s.arms) {
					this.rule(r, r.loc, false)
				}
				return
			case "recursive":
				for (const r of s.recursive.base) {
					this.rule(r, r.loc, false)
				}
				for (const r of s.recursive.rec) {
					this.rule(r, r.loc, true)
				}
				return
			case "attach":
				this.stage(s.input)
				this.stage(s.attach.child.stage)
				return
			case "approx":
				return failRecursion(here, {
					kind: "approximateSource",
					recursion: this.name
				})
			case "named":
			case "order":
			case "take":
				this.stage(s.input)
				return
		}
	}
}

const isSelf = (s: ResolvedSource): boolean => s.kind === "self"

/**
 * What a step would read whole for every row it extends, below a source it matches or negates: a recursion, which
 * PostgreSQL computes once as a CTE, a relation with no index, and a union of several rules, which it deduplicates
 * before any join reaches it, so neither is ever read at the row a step extends.
 */
type WholeRead =
	| { readonly kind: "recursiveStep"; readonly inner: string }
	| { readonly kind: "unionStep"; readonly rules: number }

/**
 * The first whole read of a stage, at any depth of the sources its rules match or negate and of their interiors, a
 * recursion before a union where a stage holds both; none for a stage of one rule over stored relations and such
 * stages alone.
 */
const wholeRead = (stage: ResolvedStage): WholeRead | undefined => {
	switch (stage.kind) {
		case "rules":
			return rulesWhole(stage.arms)
		case "union": {
			const input = wholeRead(stage.input)
			return input?.kind === "recursiveStep"
				? input
				: firstWhole(stage.arms, { kind: "unionStep", rules: unionRules(stage) })
		}
		case "recursive":
			return { kind: "recursiveStep", inner: stage.recursive.name }
		case "attach":
			return wholeRead(stage.input) ?? wholeRead(stage.attach.child.stage)
		case "named":
		case "order":
		case "take":
			return wholeRead(stage.input)
		case "approx":
			return undefined
	}
}

/** The rules a union stage unions: its own arms beside the rules its input contributes (`inputRules`). */
const unionRules = (stage: Extract<ResolvedStage, { readonly kind: "union" }>): number =>
	stage.arms.length + inputRules(stage.input)

/**
 * The rules a union's input contributes: a stage of rules its arms, a union its own count, a name its input's, which it
 * names without making a stage of its own; and a stage whose rows an order and its take, an attachment, an approximate
 * search or a recursion make, one source of them.
 */
const inputRules = (input: ResolvedStage): number => {
	switch (input.kind) {
		case "rules":
			return input.arms.length
		case "union":
			return unionRules(input)
		case "named":
			return inputRules(input.input)
		case "order":
		case "take":
		case "attach":
		case "approx":
		case "recursive":
			return 1
	}
}

/** The first whole read of a list of rules: a union where they are several, else the one rule's. */
const rulesWhole = (rules: NonEmptyReadonlyArray<ResolvedRule>): WholeRead | undefined => {
	const [only, ...more] = rules
	return more.length > 0
		? firstWhole(rules, { kind: "unionStep", rules: rules.length })
		: ruleWhole(only)
}

/** A recursion read by any of `rules`, else the union they make. */
const firstWhole = (rules: ReadonlyArray<ResolvedRule>, union: WholeRead): WholeRead =>
	rules.map(ruleWhole).find((w) => w?.kind === "recursiveStep") ?? union

/** The first whole read of one rule, below the sources it matches or negates and in its interiors. */
const ruleWhole = (rule: ResolvedRule): WholeRead | undefined => {
	const reads = [
		...ownSources(rule, rule.loc).flatMap(({ source }) =>
			source.kind === "query" || source.kind === "step" ? [wholeRead(source.query.stage)] : []
		),
		...rule.interiors.map((interior) => rulesWhole(interior.arms))
	]
	return reads.find((w) => w?.kind === "recursiveStep") ?? reads.find((w) => w !== undefined)
}

/**
 * The structural admission of a recursive definition, read from its description before any arm is checked.
 *
 * What makes a recursion admissible or not is visible in the rules the author wrote: how often a recursive arm reads
 * `self`, whether it negates or aggregates over it, whether an approximate source feeds it, and whether every arm
 * delivers the declared state heading. These are refused here, each with its own capability, at the arm and clause
 * that cause it, before the checker builds any node:
 *
 * - an arm whose head is not exactly the declared row, MalformedDescription `armHead` (a recursion is never a union
 *   of different headings, because feedback identity is the complete state tuple);
 * - an attachment made on an arm, UnsupportedOperation `armAttachment`: an attachment is not part of the state the
 *   fixed point deduplicates, so it attaches to the completed recursion instead;
 * - a recursive arm that reads `self` twice, UnsupportedOperation `nonlinearFeedback`
 *   (PostgreSQL's recursive term admits one self-reference, and a nonlinear self-join needs a proved transformation
 *   the compiler does not have);
 * - `r.not(self, ...)`, UnsupportedOperation `selfNegation` (negation is
 *   monotone only over a fixed external relation or an earlier completed stratum), and an existence of self,
 *   UnsupportedOperation `selfExistence` (a recursive arm reads self through its one match);
 * - an aggregate head on an arm that reads `self`, or an r.pack head, which groups by the head's other terms as an
 *   aggregate does, UnsupportedOperation `recursiveAggregation` (PostgreSQL has
 *   no ordinary recursive aggregate fixed point; a fold over one working-table batch is not one). intersection and
 *   difference are per-row producers and stay admitted;
 * - an approximate source anywhere below an arm, UnsupportedOperation `approximateSource` (approximate candidates never enter recursive feedback).
 *
 * Mutual recursion has no description: a definition's `self` names that definition only and is a source only of its
 * own recursive arms, and a query's description embeds the queries it imports by value, so
 * no stage can name a relation that reads it back. A `self` anywhere else, in a base arm, an interior, an imported
 * query or an attachment child, is MalformedDescription; the description's structural check refuses it before the
 * checker runs (description.ts), and this scan repeats the refusal with the recursion's reason for any caller that
 * reaches the plug-in directly.
 *
 * A recursive arm that reads no `self` adds the same facts on every iteration, so it is folded into the base: the least
 * fixed point of B ∪ C ∪ T(R) is that of (B ∪ C) ∪ T(R).
 *
 * The arms of a definition, checked against the structural admission rules above.
 */
export const scanArms = (def: ResolvedRecursive): ScannedArms => {
	const name = def.name
	const row = Object.keys(def.row).toSorted(compareStrings)
	const nested = new Nested(name)
	const heading = (arm: Arm, list: RecursionArm): void => {
		const head = Object.keys(arm.rule.head).toSorted(compareStrings)
		const missing = row.filter((c) => !head.includes(c))
		const extra = head.filter((c) => !row.includes(c))
		if (missing.length > 0 || extra.length > 0) {
			failRecursion(childLoc(arm.loc, "head"), {
				kind: "armHead",
				recursion: name,
				arm: list,
				row,
				missing,
				extra
			})
		}
		const [attached] = arm.rule.attach
		if (attached !== undefined) {
			failRecursion(attached.loc, {
				kind: "armAttachment",
				recursion: name,
				arm: list
			})
		}
	}
	const declared = mapNonEmpty(def.base, (rule) => {
		const arm = typedArm(rule, def.row)
		heading(arm, "base")
		for (const { source, loc } of ownSources(arm.rule, arm.loc)) {
			if (isSelf(source)) {
				failRecursion(loc, { kind: "baseSelf", recursion: name })
			}
		}
		nested.rule(arm.rule, arm.loc, true)
		return arm
	})
	const selfFree: Array<Arm> = []
	const rec: Array<RecArm> = []
	for (const rule of def.rec) {
		const arm = typedArm(rule, def.row)
		heading(arm, "rec")
		const selves = arm.rule.matches.flatMap((match, at) =>
			isSelf(match.source) ? [{ at, match }] : []
		)
		const [firstSelf, secondSelf] = selves
		if (secondSelf !== undefined) {
			failRecursion(secondSelf.match.loc, {
				kind: "nonlinearFeedback",
				recursion: name,
				selfReads: selves.length
			})
		}
		const selfFilter = arm.rule.where
			.flatMap((e, j) => filters(e, where(arm.loc, "where", j)))
			.find((f) => isSelf(f.filter.source))
		if (selfFilter !== undefined) {
			failRecursion(selfFilter.loc, {
				kind: selfFilter.filter.kind === "absent" ? "selfNegation" : "selfExistence",
				recursion: name
			})
		}
		const [fold] = entries(arm.rule.head).flatMap(
			([key, h]): ReadonlyArray<{
				readonly key: string
				readonly fold: "count" | "sum" | "mean" | "min" | "max" | "pack"
			}> => {
				if (h.kind === "aggregate") {
					return [{ key, fold: h.fn }]
				}
				return h.kind === "producer" && h.fn === "pack" ? [{ key, fold: h.fn }] : []
			}
		)
		if (firstSelf !== undefined && fold !== undefined) {
			failRecursion(where(arm.loc, "head", fold.key), {
				kind: "recursiveAggregation",
				recursion: name,
				fold: fold.fold
			})
		}
		nested.rule(arm.rule, arm.loc, true)
		if (firstSelf !== undefined) {
			for (const { source, loc } of ownSources(arm.rule, arm.loc)) {
				const whole =
					source.kind === "query" || source.kind === "step"
						? wholeRead(source.query.stage)
						: undefined
				if (whole !== undefined) {
					failRecursion(loc, { ...whole, recursion: name })
				}
			}
			rec.push({ ...arm, self: firstSelf })
		} else {
			selfFree.push(arm)
		}
	}
	return { base: [...declared, ...selfFree], rec }
}
