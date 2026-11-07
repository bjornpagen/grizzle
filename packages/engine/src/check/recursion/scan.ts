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
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"

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

/** The relational negations anywhere in an expression, with their structural locations. */
type Absent = {
	readonly absent: Extract<ResolvedExpr, { readonly kind: "absent" }>
	readonly loc: SourceLoc
}

const absents = (e: ResolvedExpr, loc: SourceLoc): ReadonlyArray<Absent> => {
	const sub = (x: ResolvedExpr, segment: string | number): ReadonlyArray<Absent> =>
		absents(x, childLoc(loc, segment))
	switch (e.kind) {
		case "absent":
			return [{ absent: e, loc }, ...entries(e.bindings).flatMap(([column, b]) => sub(b, column))]
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return e.args.flatMap((a, i) => sub(a, i))
		case "cast":
		case "base":
		case "not":
		case "in":
			return sub(e.arg, "arg")
		case "cond":
			return [...sub(e.pred, "pred"), ...sub(e.onTrue, "onTrue"), ...sub(e.onFalse, "onFalse")]
		case "when":
			return [
				...sub(e.subject, "subject"),
				...sub(e.proved, "proved"),
				...sub(e.otherwise, "otherwise")
			]
		case "compare":
		case "allen":
			return [...sub(e.left, "left"), ...sub(e.right, "right")]
		case "between":
			return [...sub(e.arg, "arg"), ...sub(e.low, "low"), ...sub(e.high, "high")]
		case "pointIn":
			return [...sub(e.point, "point"), ...sub(e.span, "span")]
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return []
	}
}

/** Every source a rule reads in its own scope, its matches' and its negations', with their locations. */
const ownSources = (
	rule: ResolvedRule,
	loc: SourceLoc
): ReadonlyArray<{ readonly source: ResolvedSource; readonly loc: SourceLoc }> => [
	...rule.matches.map((m) => ({ source: m.source, loc: m.loc })),
	...rule.where.flatMap((e, i) =>
		absents(e, where(loc, "where", i)).map((f) => ({ source: f.absent.source, loc: f.loc }))
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
			if (source.kind === "query") {
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
 *   monotone only over a fixed external relation or an earlier completed stratum);
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
		const selfNegation = arm.rule.where
			.flatMap((e, j) => absents(e, where(arm.loc, "where", j)))
			.find((f) => isSelf(f.absent.source))
		if (selfNegation !== undefined) {
			failRecursion(selfNegation.loc, { kind: "selfNegation", recursion: name })
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
			rec.push({ ...arm, self: firstSelf })
		} else {
			selfFree.push(arm)
		}
	}
	return { base: [...declared, ...selfFree], rec }
}
