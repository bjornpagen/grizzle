import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import { compileReasonText, malformedDescription } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { CombineFn, MonoidSpec } from "#compiler/ir/monoid.ts"
import { type ScalarType, sameEnteredType, typeLabel, enteredType } from "#compiler/ir/scalar.ts"
import {
	exprEmitter,
	lowerPredicate,
	noClosedRelations,
	noParams
} from "#compiler/scalar/compute/lower.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { textLookup } from "#compiler/text/refinement.ts"

/**
 * A fold's typing (fin.md §4.3, w4-w7 §2.3): what `fold(family, Monoid.m, step, end)` names, resolved to its fields.
 * The theory resolves the statement's sides to these fields (analysis/theory); this rule says whether their types and
 * writings are the monoid's.
 */
export interface FoldTyping {
	/** The family's order: a counted family hides its order, so it names no accumulator of its own. */
	readonly order: "ordered" | "counted"
	/** The step side's value, x, after its group: none for count. */
	readonly step: LawField | undefined
	/** The (before, after) accumulators the step side names after x, one pair per plane, or none. */
	readonly pairs: ReadonlyArray<{ readonly before: LawField; readonly after: LawField }>
	/** The owner's end fields the end side names after its key, one per plane. */
	readonly ends: ReadonlyArray<LawField>
}

/**
 * Why a fold's fields are not its monoid's, as the refusal's sentence, or undefined when they are. In order:
 *
 * - its step value: present exactly when the monoid reads one (count reads none), of a carrier the monoid admits;
 * - its monoid: a commutative one over a counted family, whose order is hidden, so concat folds only a sequence, and
 *   names its accumulators there, since its law reads each member's running value, which no aggregate over the
 *   family's set of members states;
 * - its accumulators: none over a counted family, whose per-member accumulator would show the hidden order; otherwise
 *   none, or one (before, after) pair per plane;
 * - its ends: one per plane;
 * - every accumulator and end: an accumulated field (desc.ts Writing) of the plane's type, x's (natural for count, which
 *   counts), but for its own text refinement (scalar.ts sameEnteredType), with no implicit cast, starting at the
 *   monoid's identity on the plane, plane by plane. The step's values, and so the running values, need not lie in an
 *   accumulator's pattern or byte bound: its column's domain refuses one outside it, an outcome on that pattern's rule.
 */
export const foldRule = (monoid: MonoidSpec, fold: FoldTyping): string | undefined => {
	const x = fold.step
	if (monoid.step === "none" && x !== undefined) {
		return `a ${monoid.name} fold steps by one, so its step side names no value after its group; it names ${x.name}`
	}
	if (monoid.step === "value" && x === undefined) {
		return `a ${monoid.name} fold steps by a value: its step side names it after its group`
	}
	if (x !== undefined && !monoid.admits(x.type)) {
		return `a step value of a carrier ${monoid.name} admits; ${x.name} is ${typeLabel(x.type)}`
	}
	if (fold.order === "counted" && !monoid.commutative) {
		return `a fold over a counted family combines in a commutative monoid, since the family's order is hidden; ${monoid.name} is not: fold an ordered family or a tree by it`
	}
	if (!monoid.commutative && fold.pairs.length === 0) {
		return `a ${monoid.name} fold names its (before, after) pair after its value: its combine depends on the members' order, which its law reads through each member's running value`
	}
	if (fold.order === "counted" && fold.pairs.length > 0) {
		return "a fold over a counted family hides its accumulators: name the step's value alone"
	}
	if (fold.pairs.length !== 0 && fold.pairs.length !== monoid.planes) {
		return `a ${monoid.name} fold's step names no accumulator or one (before, after) pair per plane, ${monoid.planes}; it names ${fold.pairs.length}`
	}
	const [firstEnd] = fold.ends
	if (firstEnd === undefined || fold.ends.length !== monoid.planes) {
		return `a fold's end names one accumulated field of the owner per plane, ${monoid.planes}; it names ${fold.ends.length}`
	}
	const plane = x?.type ?? firstEnd.type
	if (!monoid.admits(plane)) {
		return `a ${monoid.name} fold's end of a carrier it admits; ${firstEnd.name} is ${typeLabel(firstEnd.type)}`
	}
	const identity = monoid.identity(plane)
	const accumulator = (f: LawField, i: number): string | undefined => {
		if (!sameEnteredType(f.type, plane)) {
			return `a ${monoid.name} fold's accumulator of its plane's type ${typeLabel(enteredType(plane))}, at any pattern or byte bound; ${f.name} is ${typeLabel(f.type)}`
		}
		if (f.writing.kind !== "accumulated") {
			return `a fold's accumulator is an accumulated field, filled on the host; ${f.name} is written by ${f.writing.kind}`
		}
		const start = defined(identity[i], "a monoid's identity holds one value per plane")
		if (!canonicalEquals(f.writing.start, start, everyProperty)) {
			return `a fold's accumulator starts at its monoid's identity; ${f.name} starts elsewhere`
		}
		return undefined
	}
	for (const [i, pair] of fold.pairs.entries()) {
		const refused = accumulator(pair.before, i) ?? accumulator(pair.after, i)
		if (refused !== undefined) {
			return refused
		}
	}
	for (const [i, end] of fold.ends.entries()) {
		const refused = accumulator(end, i)
		if (refused !== undefined) {
			return refused
		}
	}
	return undefined
}

/**
 * An operand of a combine's CHECK as its typing reads it: a before, the after or the step value, each a column of the
 * plane's type, compared by its value (Compute.base), since natural's count is a contract over bigint and its `+` an
 * exact integer, which meets the contract only through its base.
 */
const operand: ExprDesc = { kind: "base", arg: { kind: "field", field: "plane" } }

/** The step one a count adds: the integer 1, of no type of its own until it meets the plane. */
const one: ExprDesc = { kind: "literal", value: 1n, type: undefined }

/**
 * Why the CHECK that proves a fold's after over a plane of type `plane` is no total predicate, as the refusal's
 * sentence, or undefined when it is one: every after, named or hidden, is a drawn law column the host fills, proved by
 * `(after = combine(befores, x)) IS TRUE` (fin.md §4.3), typed in "check" mode as a row check is, each before, after
 * and x a column of the plane's type with no text refinement (scalar.ts enteredType), which each of them refines on its
 * own. The comparison widens both sides into exact arithmetic where the combine computes
 * there (count's and sum's `+`), so nothing narrows; the combine applies Compute's operations (ir/monoid.ts CombineFn),
 * each of which a check admits only where the host evaluates it, as it must to fill the after.
 */
export const combineRule = (monoid: MonoidSpec, plane: ScalarType): string | undefined => {
	const loc = SourceLoc(`fold ${monoid.name}`, [])
	const carrier = enteredType(plane)
	const patterns = new CompilePatterns()
	const befores: NonEmptyReadonlyArray<ExprDesc> =
		monoid.planes === 2 ? [operand, operand] : [operand]
	const combined = monoid.combine<ExprDesc>(
		befores,
		monoid.step === "none" ? { kind: "one" } : { kind: "value", expr: operand },
		{ one, apply: (fn: CombineFn, left, right) => ({ kind: "compute", fn, args: [left, right] }) }
	)
	for (const [i, after] of combined.entries()) {
		const typed = lowerPredicate(
			{ kind: "compare", op: "eq", left: operand, right: after },
			{
				mode: "check",
				loc,
				emit: exprEmitter(`fold ${monoid.name}`),
				leaf: () => Result.ok({ kind: "value", args: [], type: carrier, nonNull: "storage" }),
				params: noParams,
				fieldType: () =>
					Result.err(malformedDescription(loc, "no descriptor: a combine reads its planes alone")),
				closed: noClosedRelations("a fold's combine reads its planes and its step alone"),
				patterns,
				patternLanguage: textLookup
			}
		)
		if (!typed.ok) {
			return `a ${monoid.name} fold's plane ${i} over ${typeLabel(plane)}, proved by after = combine(before, x): ${compileReasonText(typed.error.reason)}`
		}
	}
	return undefined
}
