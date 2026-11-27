import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import {
	type RuleBreach,
	proseBreach,
	compileReasonText,
	namedBreach
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { type CombineFn, combine, type MonoidSpec } from "#compiler/ir/monoid.ts"
import { enteredType, entersColumn, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { exprEmitter, lowerPredicate } from "#compiler/scalar/compute/lower.ts"
import { noClosedRelations, noParams } from "#compiler/scalar/compute/typing.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"

/**
 * A fold's typing: what `fold(family, Monoid.m, step, end)` names, resolved to its fields.
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

/** A fold's field of another type than its plane's, a rule the types name too. */
export const foldPlane: Refused =
	"a fold's accumulators and ends are of its plane's type: another integer width, numeric typmod or contract is another type"

/**
 * Why a fold's fields are not its monoid's, as the rule they break (RuleBreach), or undefined when they are. In order:
 *
 * - its step value: present exactly when the monoid reads one (count reads none), of a carrier the monoid admits;
 * - its monoid: a commutative one over a counted family, whose order is hidden, so concat folds only a sequence, and
 *   names its accumulators there, since its law reads each member's running value, which no aggregate over the
 *   family's set of members states;
 * - its accumulators: none over a counted family, whose per-member accumulator would show the hidden order; otherwise
 *   none, or one (before, after) pair per plane;
 * - its ends: one per plane;
 * - every accumulator and end: an accumulated field (desc.ts Writing) of the plane's type, x's (natural for count, which
 *   counts), but for its own text refinement and a closed id's subset holding the plane's (scalar.ts entersColumn),
 *   with no implicit cast, starting at the
 *   monoid's identity on the plane, plane by plane. The step's values, and so the running values, need not lie in an
 *   accumulator's pattern or byte bound: its column's domain refuses one outside it, an outcome on that pattern's rule.
 */
export const foldRule = (monoid: MonoidSpec, fold: FoldTyping): RuleBreach | undefined => {
	const x = fold.step
	if (monoid.step === "none" && x !== undefined) {
		return proseBreach(
			`a ${monoid.name} fold steps by one, so its step side names no value after its group; it names ${x.name}`
		)
	}
	if (monoid.step === "value" && x === undefined) {
		return proseBreach(
			`a ${monoid.name} fold steps by a value: its step side names it after its group`
		)
	}
	if (x !== undefined && !monoid.admits(x.type)) {
		return namedBreach(
			"the monoid admits the step value's type: sum an exact number, or and twos a set, max an ordered value with a least one, concat a text"
		)
	}
	if (fold.order === "counted" && !monoid.commutative) {
		return namedBreach(
			"a fold over a counted family combines in a commutative monoid: concat folds an ordered family or a tree"
		)
	}
	if (!monoid.commutative && fold.pairs.length === 0) {
		return namedBreach(
			"a concat fold names its (before, after) pair after its value: its law reads each member's running value"
		)
	}
	if (fold.order === "counted" && fold.pairs.length > 0) {
		return namedBreach(
			"a fold over a counted family hides its accumulators: name the step's value alone"
		)
	}
	if (fold.pairs.length !== 0 && fold.pairs.length !== monoid.planes.length) {
		return proseBreach(
			`a ${monoid.name} fold's step names no accumulator or one (before, after) pair per plane, ${monoid.planes.length}; it names ${fold.pairs.length}`
		)
	}
	const [firstEnd] = fold.ends
	if (firstEnd === undefined || fold.ends.length !== monoid.planes.length) {
		return namedBreach("a fold's end names one accumulated field of the owner per plane")
	}
	const plane = x?.type ?? firstEnd.type
	if (!monoid.admits(plane)) {
		return proseBreach(
			`a ${monoid.name} fold's end of a carrier it admits; ${firstEnd.name} is ${typeLabel(firstEnd.type)}`
		)
	}
	const identity = monoid.identity(plane)
	const accumulator = (f: LawField, i: number): RuleBreach | undefined => {
		if (!entersColumn(f.type, plane)) {
			return namedBreach(foldPlane)
		}
		if (f.writing.kind !== "accumulated") {
			return proseBreach(
				`a fold's accumulator is an accumulated field, filled on the host, or a text's SHA-256 digest, a generated field Crypto.sha256(row.v) over the accumulated v; ${f.name} is written by ${f.writing.kind}`
			)
		}
		const start = defined(identity[i], "a monoid's identity holds one value per plane")
		if (!canonicalEquals(f.writing.start, start)) {
			return proseBreach(
				`a fold's accumulator starts at its monoid's identity; ${f.name} starts elsewhere`
			)
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
 * plane's type, compared by its value (Type.base), since natural's count is a contract over bigint and its `+` an
 * exact integer, which meets the contract only through its base.
 */
const operand: ExprDesc = { kind: "base", arg: { kind: "field", field: "plane" } }

/** The step one a count adds: the integer 1, of no type of its own until it meets the plane. */
const one: ExprDesc = { kind: "literal", value: 1n }

/**
 * Why the CHECK that proves a fold's after over a plane of type `plane` is no total predicate, as the refusal's
 * sentence, or undefined when it is one: every after, named or hidden, is a drawn law column the host fills, proved by
 * `(after = combine(befores, x)) IS TRUE`, typed in "check" mode as a row check is, each before, after
 * and x a column of the plane's type with no text refinement (scalar.ts enteredType), which each of them refines on its
 * own. The comparison widens both sides into exact arithmetic where the combine computes
 * there (count's and sum's `+`), so nothing narrows; the combine applies the scalar operations (ir/monoid.ts CombineFn),
 * each of which a check admits only where the host evaluates it, as it must to fill the after. It reads `patterns`,
 * its compile's table, and types a descriptor the typing derives as the registry does outside any schema (bareEnv): a
 * concatenation of a contract's bounded text, whose base the operand reads, is a text within the bytes its parts take
 * together (scalar/compute/typing.ts textWithinBytes), which the equation is judged at.
 */
export const combineRule = (
	monoid: MonoidSpec,
	plane: ScalarType,
	patterns: PatternAutomata
): string | undefined => {
	const loc = SourceLoc(`fold ${monoid.name}`, [])
	const carrier = enteredType(plane)
	const befores: NonEmptyReadonlyArray<ExprDesc> = mapNonEmpty(monoid.planes, () => operand)
	const combined = combine<ExprDesc>(
		monoid,
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
				fieldType: (desc, at) => scalarTypeOf(desc, bareEnv, at),
				closed: noClosedRelations("a fold's combine reads its planes and its step alone"),
				patterns
			}
		)
		if (!typed.ok) {
			return `a ${monoid.name} fold's plane ${i} over ${typeLabel(plane)}, proved by after = combine(before, x): ${compileReasonText(typed.error.reason)}`
		}
	}
	return undefined
}
