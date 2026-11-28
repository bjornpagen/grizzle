/**
 * What the properties of concat-equation.test.ts read, and test/pg/compute/concat-equation.test.ts beside them: an
 * equation of a text with a concatenation of two to five parts, drawn as a concatenation tree of any bracketing, its
 * parts and the rows it is read over, and the plain meaning it must have.
 */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Engine from "@bjornpagen/grizzle-text/base/result"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Predicate, Record as Rec, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	languageOctets,
	languageWithin,
	type ScalarType,
	textBoundsOf,
	wildcardPattern
} from "#compiler/ir/scalar.ts"
import { compiledExpr, sqlNull, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { byteaMaxLength } from "#compiler/scalar/values/fault.ts"
import type { HostValue } from "#compiler/scalar/values/identity.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { evaluate } from "#test/support/oracle/evaluate/catalog.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	field as testField,
	type LeafBinding,
	type LoweredTable,
	lowerWith,
	testPg
} from "#test/support/unit/compute/support.ts"

/**
 * What a part of a drawn concatenation is: a text column, its pattern bounding its bytes or not; a bare literal; a
 * translation of an unbounded column, Text.translate(x, "a", "b"), which a query refuses, since its operand's pattern
 * bounds no length; or an integer column, which no concatenation takes.
 */
export type DrawnPart =
	| { readonly kind: "column"; readonly bounded: boolean }
	| { readonly kind: "literal"; readonly text: string }
	| { readonly kind: "translated" }
	| { readonly kind: "number" }

/** A concatenation tree over the parts, in order: a part, by its index, or the concatenation of two trees. */
export type Shape =
	| { readonly kind: "part"; readonly index: number }
	| { readonly kind: "concat"; readonly first: Shape; readonly second: Shape }

/** The text a concatenation is equated with: a text column of no bound, or a bare literal. */
export type Whole =
	| { readonly kind: "column" }
	| { readonly kind: "literal"; readonly text: string }

/** One row's values: the whole's, and each column part's, a translation's its column's, NULL as null. */
export interface EquationRow {
	readonly t: string | null
	readonly parts: ReadonlyArray<string | null>
}

/**
 * A drawn equation, `whole = parts` or its negation, the concatenation on either side, and the rows it is read over.
 * Its parts are the concatenation tree's leaves, in order.
 */
export interface EquationCase {
	readonly parts: NonEmptyReadonlyArray<DrawnPart>
	readonly shape: Shape
	readonly whole: Whole
	readonly mirrored: boolean
	readonly ne: boolean
	readonly rows: ReadonlyArray<EquationRow>
}

/** The characters a value is drawn of: one byte, two, and four, a pair of UTF-16 code units. */
const characters = ["a", "b", "é", "😀"] as const

/** A text of up to three characters, the empty one among them. */
const textGen: Gen<string> = (s) =>
	Arr.join(s.draw(array(element(characters), { min: 0, max: 3 })), "")

/** A text of `n` characters. */
const textOfLength =
	(n: number): Gen<string> =>
	(s) =>
		Arr.join(s.draw(array(element(characters), { min: n, max: n })), "")

/** A concatenation tree over the parts `low` to `high` - 1, at least one, bracketed at a drawn split. */
const shapeGen =
	(low: number, high: number): Gen<Shape> =>
	(s) => {
		if (high - low === 1) {
			return { kind: "part", index: low }
		}
		const split = s.draw(int(low + 1, high - 1))
		return {
			kind: "concat",
			first: s.draw(shapeGen(low, split)),
			second: s.draw(shapeGen(split, high))
		}
	}

/** Each part's place in its own concatenation, by index: its first operand, or its second. */
const placesOf = (shape: Shape): ReadonlyArray<"first" | "second"> => {
	const places: Array<"first" | "second"> = []
	const visit = (s: Shape, place: "first" | "second"): void => {
		if (s.kind === "part") {
			places[s.index] = place
			return
		}
		visit(s.first, "first")
		visit(s.second, "second")
	}
	visit(shape, "first")
	return places
}

/** The depth of the deepest concatenation nested in a shape: 1 for one concatenation of two parts. */
const depthOf = (shape: Shape): number =>
	shape.kind === "part" ? 0 : 1 + Math.max(depthOf(shape.first), depthOf(shape.second))

/** A part a query and a check both lower: a text column, bounded or not, or, standing second, a bare literal. */
const loweredPartGen =
	(place: "first" | "second"): Gen<DrawnPart> =>
	(s) =>
		place === "second" && s.draw(int(0, 3)) === 0
			? { kind: "literal", text: s.draw(textGen) }
			: { kind: "column", bounded: s.draw(boolean) }

/**
 * A part of any kind, most often one every site lowers: a column, a literal, a translation a query refuses, or an
 * integer column, at either place, so a literal stands first now and then, which every site refuses.
 */
const anyPartGen: Gen<DrawnPart> = weighted<DrawnPart>([
	[6, (s) => ({ kind: "column", bounded: s.draw(boolean) })],
	[2, (s) => ({ kind: "literal", text: s.draw(textGen) })],
	[1, () => ({ kind: "translated" })],
	[1, () => ({ kind: "number" })]
])

/** A part's value in a row: a literal's own text, a column's drawn value or NULL. */
const partValueGen =
	(part: DrawnPart): Gen<string | null> =>
	(s) =>
		part.kind === "literal"
			? part.text
			: s.draw(
					weighted<string | null>([
						[12, textGen],
						[1, () => null]
					])
				)

/** The text a part reads in a row: a translation maps a to b. */
const readOf = (part: DrawnPart, value: string | null): string | null =>
	value === null ? null : part.kind === "translated" ? Str.replaceAll("a", "b")(value) : value

/** The texts the parts read, where none reads NULL. */
const textsOf = (read: ReadonlyArray<string | null>): ReadonlyArray<string> | undefined => {
	const texts = Arr.filter(read, Predicate.isNotNull)
	return texts.length === read.length ? texts : undefined
}

/**
 * A row over the parts: the whole most often the parts' concatenation, else that concatenation with one middle part
 * replaced by another text of its length, so the lengths hold and the middle part does not, else any text; NULL now and
 * then.
 */
const rowGen =
	(parts: NonEmptyReadonlyArray<DrawnPart>): Gen<EquationRow> =>
	(s) => {
		const values = Arr.map(parts, (p) => s.draw(partValueGen(p)))
		const read = Arr.map(parts, (p, i) => readOf(p, values[i] ?? null))
		const texts = textsOf(read)
		const joined = texts === undefined ? undefined : Arr.join(texts, "")
		const middle = Arr.filter(
			Array.from({ length: parts.length }, (_, i) => i),
			(i) => i > 0 && i < parts.length - 1 && (read[i] ?? "") !== ""
		)
		const replaced = (): string | undefined => {
			if (joined === undefined || !Arr.isReadonlyArrayNonEmpty(middle)) {
				return undefined
			}
			const at = s.draw(element(middle))
			const was = read[at] ?? ""
			const other = s.draw(textOfLength(Array.from(was).length))
			return Arr.join(
				Arr.map(read, (r, i) => (i === at ? other : (r ?? ""))),
				""
			)
		}
		const t = s.draw(
			weighted<string | null>([
				[6, () => joined ?? s.draw(textGen)],
				[4, () => replaced() ?? joined ?? s.draw(textGen)],
				[2, textGen],
				[1, () => null]
			])
		)
		return { t, parts: values }
	}

/** A drawn equation of two to five parts over parts drawn by `partOf`, at their places, and a few rows. */
const equationGen =
	(partOf: (place: "first" | "second") => Gen<DrawnPart>): Gen<EquationCase> =>
	(s) => {
		const n = s.draw(int(2, 5))
		const shape = s.draw(shapeGen(0, n))
		const places = placesOf(shape)
		const [head, ...tail] = Arr.map(
			Array.from({ length: n }, (_, i) => i),
			(i) => s.draw(partOf(defined(places[i], "a part's place")))
		)
		const parts: NonEmptyReadonlyArray<DrawnPart> = [defined(head, "the first part"), ...tail]
		return {
			parts,
			shape,
			whole: s.draw(boolean) ? { kind: "column" } : { kind: "literal", text: s.draw(textGen) },
			mirrored: s.draw(boolean),
			ne: s.draw(int(0, 3)) === 0,
			rows: s.draw(array(rowGen(parts), { min: 1, max: 12 }))
		}
	}

/** An equation over parts every site lowers, columns and literals standing second. */
export const loweredEquationGen: Gen<EquationCase> = equationGen(loweredPartGen)

/** An equation over parts of every kind, at any place. */
export const anyEquationGen: Gen<EquationCase> = equationGen(() => anyPartGen)

/** A text column of no bound, and one whose pattern bounds it within 16 bytes. */
const unbounded = { kind: "column", type: testPg.text.scalar } as const satisfies LeafBinding
const bounded = {
	kind: "column",
	type: testPg.regex("^.{0,4}$", "su").scalar
} as const satisfies LeafBinding

/** The column part `i` reads. */
export const partColumn = (i: number): string => `p${i}`

/** A part's description: its column, its literal, its column translated, or its integer column. */
const partDesc = (part: DrawnPart, i: number): ExprDesc => {
	switch (part.kind) {
		case "column":
		case "number":
			return { kind: "var", var: partColumn(i) }
		case "literal":
			return { kind: "literal", value: part.text }
		case "translated":
			return {
				kind: "compute",
				fn: "translate",
				args: [
					{ kind: "var", var: partColumn(i) },
					{ kind: "literal", value: "a" },
					{ kind: "literal", value: "b" }
				]
			}
	}
}

/** A shape's concatenation, nested as the shape is, each part `i` the description `partAt(i)`. */
const shapeDesc = (partAt: (i: number) => ExprDesc, shape: Shape): ExprDesc =>
	shape.kind === "part"
		? partAt(shape.index)
		: {
				kind: "compute",
				fn: "concat",
				args: [shapeDesc(partAt, shape.first), shapeDesc(partAt, shape.second)]
			}

/** An equation case's part `i`'s description. */
const equationPartAt =
	(c: EquationCase) =>
	(i: number): ExprDesc =>
		partDesc(defined(c.parts[i], "a shape's part"), i)

/** The whole's description: the column t, or its literal. */
const wholeDesc = (whole: Whole): ExprDesc =>
	whole.kind === "column" ? { kind: "var", var: "t" } : { kind: "literal", value: whole.text }

/** The equation of the whole with `cat`, on the case's side, `=` or `<>`. */
const equationOf = (c: EquationCase, cat: ExprDesc): ExprDesc => {
	const whole = wholeDesc(c.whole)
	return {
		kind: "compare",
		op: c.ne ? "ne" : "eq",
		left: c.mirrored ? cat : whole,
		right: c.mirrored ? whole : cat
	}
}

/** The case's equation, its concatenation nested as its shape is. */
export const equationDesc = (c: EquationCase): ExprDesc =>
	equationOf(c, shapeDesc(equationPartAt(c), c.shape))

/**
 * The two-part analogue of part `i`: the case's equation over a concatenation of that part, at its own place, beside an
 * unbounded text column `c`, which every site lowers: `concat(part, c)` where the part stands first in its own
 * concatenation, `concat(c, part)` where it stands second.
 */
export const analogueDesc = (c: EquationCase, i: number): ExprDesc => {
	const part = partDesc(defined(c.parts[i], "an analogue's part"), i)
	const column: ExprDesc = { kind: "var", var: "c" }
	return equationOf(c, {
		kind: "compute",
		fn: "concat",
		args: placesOf(c.shape)[i] === "first" ? [part, column] : [column, part]
	})
}

/** Every column a case's equation or its analogues read, each at its type. */
const bindingsOf = (c: EquationCase): Readonly<Record<string, LeafBinding>> => ({
	t: unbounded,
	c: unbounded,
	...Rec.fromEntries(
		Arr.map(c.parts, (p, i): readonly [string, LeafBinding] => [
			partColumn(i),
			p.kind === "number"
				? { kind: "column", type: testPg.integer.scalar }
				: p.kind === "column" && p.bounded
					? bounded
					: unbounded
		])
	)
})

/** The case's equation, or an analogue, lowered at a site. */
export const loweredAt = (
	mode: "query" | "check",
	c: EquationCase,
	desc: ExprDesc
): Engine.Result<LoweredTable, CompileError> =>
	lowerWith(mode, desc, bindingsOf(c), true, baseParams)

/**
 * The equation's plain meaning over a row, three-valued: NULL where the whole or any part reads NULL, else whether the
 * whole is the parts' texts in order, negated for `<>`.
 */
export const meaningOf = (c: EquationCase, row: EquationRow): boolean | null => {
	const whole = c.whole.kind === "column" ? row.t : c.whole.text
	const read = Arr.map(c.parts, (p, i) =>
		readOf(p, p.kind === "literal" ? p.text : (row.parts[i] ?? null))
	)
	const texts = textsOf(read)
	if (whole === null || texts === undefined) {
		return null
	}
	const holds = whole === Arr.join(texts, "")
	return c.ne ? !holds : holds
}

/** A row's value of a column, NULL where the row reads none. */
const columnOf = (c: EquationCase, row: EquationRow, name: string): string | undefined => {
	if (name === "t") {
		return row.t ?? undefined
	}
	const at = Arr.findFirstIndex(
		Array.from({ length: c.parts.length }, (_, i) => i),
		(i) => partColumn(i) === name
	)
	return Option.isSome(at) ? (row.parts[at.value] ?? undefined) : undefined
}

/** The host's value of a lowered expression over a row whose columns `column` reads, NULL as null (scalar/compute/evaluate.ts). */
const hostValue = (
	root: ScalarExpr,
	column: (name: string) => string | undefined
): HostValue | null => {
	const table = predicateTable(root)
	const value: HostValue | typeof sqlNull = succeeded(
		Engine.mapError(
			compiledExpr(table)(
				{
					value: undefined,
					column: (ref) => column(ref.name) ?? sqlNull,
					closed: () => undefined,
					param: noParamLeaf
				},
				ProgramPatterns.of(tablePatterns(table))
			),
			(stop) => new Error(Formatter.format(stop))
		),
		"the host evaluates it"
	)
	return value === sqlNull ? null : value
}

/**
 * The reference evaluator's value of a lowered expression over a row whose columns `column` reads, none of them NULL,
 * which it never reads (test/support/oracle/evaluate/catalog.ts).
 */
const referenceValue = (
	root: ScalarExpr,
	column: (name: string) => string | undefined
): unknown => {
	const value = evaluate(root, {
		kind: "row",
		column: (ref) => column(ref.name),
		param: () => undefined,
		regexMember: patternMember
	})
	return value._tag === "Success"
		? value.success
		: assert.fail(`the reference evaluates it: ${Formatter.format(value.failure)}`)
}

/** A truth value, as an equation's evaluation gives it. */
const truthOf = (value: unknown): boolean =>
	typeof value === "boolean" ? value : assert.fail(`a truth value: ${Formatter.format(value)}`)

/** A text, as a concatenation's evaluation gives it. */
const textOf = (value: unknown): string =>
	typeof value === "string" ? value : assert.fail(`a text: ${Formatter.format(value)}`)

/** The host's value of a lowered equation over a row: true, false or NULL (scalar/compute/evaluate.ts). */
export const hostValueOf = (
	c: EquationCase,
	root: ScalarExpr,
	row: EquationRow
): boolean | null => {
	const value = hostValue(root, (name) => columnOf(c, row, name))
	return value === null ? null : truthOf(value)
}

/**
 * The reference evaluator's value of a lowered equation over a row none of whose operands is NULL, which it never
 * reads (test/support/oracle/evaluate/catalog.ts).
 */
export const referenceValueOf = (c: EquationCase, root: ScalarExpr, row: EquationRow): boolean =>
	truthOf(referenceValue(root, (name) => columnOf(c, row, name)))

/** The native function an expression applies, when it is a native node: none for any other. */
const nativeFnOf = (e: ScalarExpr): string | undefined =>
	e.kind === "op" && typeof e.op === "string" ? nativeOp(e.op)?.fn : undefined

/** Whether an expression is the literal integer `n`, read through any cast around it. */
const isIntegerLiteral = (e: ScalarExpr, n: number): boolean =>
	e.kind === "literal"
		? e.value.kind === "int" && e.value.value === BigInt(n)
		: (e.kind === "cast" || e.kind === "domainCast") &&
			Arr.some(e.args, (a) => isIntegerLiteral(a, n))

/**
 * Whether a cond is the guard of a concatenation: its WHEN a byte count compared past the most bytes one varlena holds,
 * `… > byteaMaxLength` (scalar/values/fault.ts), so its ELSE builds a text PostgreSQL can allocate.
 */
const isBytesGuard = (cond: ScalarExpr): boolean => {
	const [when] = cond.args
	return (
		when !== undefined &&
		nativeFnOf(when) === "gt" &&
		Arr.some(when.args, (a) => isIntegerLiteral(a, byteaMaxLength))
	)
}

/**
 * The concatenations a lowered expression builds, each a chain of textcat no textcat holds, and those of them standing
 * anywhere but as the ELSE of a guard of its bytes (isBytesGuard): the concatenations a read could fail on past 1 GB.
 */
export const builtConcatenations = (
	root: ScalarExpr
): { readonly built: number; readonly unguarded: number } => {
	let built = 0
	let unguarded = 0
	const visit = (e: ScalarExpr, guarded: boolean, inConcat: boolean): void => {
		const concat = nativeFnOf(e) === "concat"
		if (concat && !inConcat) {
			built += 1
			unguarded += guarded ? 0 : 1
		}
		Arr.forEach(e.args, (a, i) =>
			visit(
				a,
				e.kind === "cond" && i === 2 && isBytesGuard(e)
					? true
					: concat || e.kind === "cast" || e.kind === "domainCast"
						? guarded
						: false,
				concat
			)
		)
	}
	visit(root, false, false)
	return { built, unguarded }
}

/** Whether a row reads NULL in the whole or a part. */
export const readsNull = (c: EquationCase, row: EquationRow): boolean => meaningOf(c, row) === null

export type EquationFeature =
	| "two parts"
	| "three parts"
	| "four parts"
	| "five parts"
	| "a concatenation nested two deep"
	| "a concatenation nested in a second operand"
	| "the equation holds"
	| "the lengths hold and a middle part differs"
	| "a NULL operand"
	| "a part of multibyte characters"
	| "an empty part"
	| "refused in a query alone"
	| "refused at every site"

/** The situations a case's shape reaches. */
export const shapeFeatures = (c: EquationCase): ReadonlyArray<EquationFeature> => {
	const counts = ["two parts", "three parts", "four parts", "five parts"] as const
	const count = defined(counts[c.parts.length - 2], "two to five parts")
	const nestedSecond = (s: Shape): boolean =>
		s.kind === "concat" &&
		(s.second.kind === "concat" || nestedSecond(s.first) || nestedSecond(s.second))
	return [
		count,
		...(depthOf(c.shape) >= 3 ? ["a concatenation nested two deep" as const] : []),
		...(nestedSecond(c.shape) ? ["a concatenation nested in a second operand" as const] : [])
	]
}

/** The situations a row reaches. */
export const rowFeatures = (c: EquationCase, row: EquationRow): ReadonlyArray<EquationFeature> => {
	const meaning = meaningOf(c, row)
	const read = Arr.map(c.parts, (p, i) =>
		readOf(p, p.kind === "literal" ? p.text : (row.parts[i] ?? null))
	)
	const whole = c.whole.kind === "column" ? row.t : c.whole.text
	const texts = textsOf(read)
	const lengthsHold =
		whole !== null &&
		texts !== undefined &&
		Array.from(whole).length === Arr.reduce(texts, 0, (n, r) => n + Array.from(r).length)
	const holds = meaning !== null && meaning !== c.ne
	return [
		...(meaning === null ? ["a NULL operand" as const] : []),
		...(holds ? ["the equation holds" as const] : []),
		...(lengthsHold && !holds && c.parts.length > 2
			? ["the lengths hold and a middle part differs" as const]
			: []),
		...(Arr.some(
			read,
			(r) => r !== null && Array.from(r).length < new TextEncoder().encode(r).length
		)
			? ["a part of multibyte characters" as const]
			: []),
		...(Arr.some(read, (r) => r === "") ? ["an empty part" as const] : [])
	]
}

/**
 * How a column part of a concatenation term bounds its bytes by its type: within 16, `^.{0,4}$`'s four characters of
 * at most four bytes each; within the lower or the upper half of the most bytes one varlena holds
 * (values/fault.ts byteaMaxLength), so the two halves together are exactly it; or not at all.
 */
const columnBounds = ["narrow", "lower half", "upper half", "none"] as const

export type ColumnBound = (typeof columnBounds)[number]

/** A part of a concatenation term: a text column of a bound, or, standing second, a bare literal. */
export type TermPart =
	| { readonly kind: "column"; readonly bound: ColumnBound }
	| { readonly kind: "literal"; readonly text: string }

/**
 * A drawn concatenation term, its parts the tree's leaves in order, and the rows it is read over: each row a value per
 * part, a literal's its own text, a column's drawn or NULL.
 */
export interface TermCase {
	readonly parts: NonEmptyReadonlyArray<TermPart>
	readonly shape: Shape
	readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
}

/** The lower half of the most bytes one varlena holds, and the upper, which together are exactly it. */
const lowerHalf = Math.floor(byteaMaxLength / 2)
const upperHalf = byteaMaxLength - lowerHalf

/**
 * A column type of `^.*$` whose bytes its type bounds at `bytes`, as str.bytes states it: its pattern's language cut to
 * them (scalar/registry.ts registerTextDescriptor).
 */
const textWithin = (bytes: number): ScalarType => {
	const patterns: Patterns = [wildcardPattern]
	const cut = languageWithin(succeeded(textLookup(patterns), "every text's language"), bytes)
	return testField({ kind: "text", patterns, language: cut, bytes: languageOctets(cut) }, "text")
		.scalar
}

/** Each column bound's type. */
const boundTypes: { readonly [B in ColumnBound]: ScalarType } = {
	narrow: bounded.type,
	"lower half": textWithin(lowerHalf),
	"upper half": textWithin(upperHalf),
	none: unbounded.type
}

/** A part of a term at its place: a column of a bound `bound` draws, or, standing second, a bare literal now and then. */
const termPartGen =
	(bound: Gen<ColumnBound>, place: "first" | "second"): Gen<TermPart> =>
	(s) =>
		place === "second" && s.draw(int(0, 3)) === 0
			? { kind: "literal", text: s.draw(textGen) }
			: { kind: "column", bound: s.draw(bound) }

/** A concatenation term of two to five parts, drawn as a tree of any bracketing, its columns' bounds by `bound`, and a few rows. */
const termGenOf =
	(bound: Gen<ColumnBound>): Gen<TermCase> =>
	(s) => {
		const n = s.draw(int(2, 5))
		const shape = s.draw(shapeGen(0, n))
		const places = placesOf(shape)
		const [head, ...tail] = Arr.map(
			Array.from({ length: n }, (_, i) => i),
			(i) => s.draw(termPartGen(bound, defined(places[i], "a part's place")))
		)
		const parts: NonEmptyReadonlyArray<TermPart> = [defined(head, "the first part"), ...tail]
		return {
			parts,
			shape,
			rows: s.draw(
				array(
					(r) =>
						Arr.map(parts, (p) =>
							p.kind === "literal"
								? p.text
								: r.draw(
										weighted<string | null>([
											[12, textGen],
											[1, () => null]
										])
									)
						),
					{ min: 1, max: 12 }
				)
			)
		}
	}

/** A term whose columns are narrow most often and of either half or of no bound now and then. */
export const termGen: Gen<TermCase> = termGenOf(
	weighted<ColumnBound>([
		[4, () => "narrow"],
		[2, () => "lower half"],
		[2, () => "upper half"],
		[2, () => "none"]
	])
)

/** A term every site holds: its columns narrow. */
export const narrowTermGen: Gen<TermCase> = termGenOf(() => "narrow")

/** The case's concatenation term, nested as its shape is. */
const termDesc = (c: TermCase): ExprDesc =>
	shapeDesc((i) => {
		const part = defined(c.parts[i], "a shape's part")
		return part.kind === "literal"
			? { kind: "literal", value: part.text }
			: { kind: "var", var: partColumn(i) }
	}, c.shape)

/** Every column a term reads, each at its bound's type. */
const termBindings = (c: TermCase): Readonly<Record<string, LeafBinding>> =>
	Rec.fromEntries(
		Arr.flatMap(c.parts, (p, i): ReadonlyArray<readonly [string, LeafBinding]> =>
			p.kind === "column" ? [[partColumn(i), { kind: "column", type: boundTypes[p.bound] }]] : []
		)
	)

/** The case's concatenation term lowered at a site. */
export const termLoweredAt = (
	mode: "query" | "check",
	c: TermCase
): Engine.Result<LoweredTable, CompileError> =>
	lowerWith(mode, termDesc(c), termBindings(c), false, baseParams)

/**
 * The most bytes the term's value can hold, as its parts' types and texts bound them: a literal's own bytes, a column's
 * its bound's, the sum over the parts; none where a part's type bounds none.
 */
export const termBytes = (c: TermCase): number | undefined => {
	const bytes = Arr.map(c.parts, (p) =>
		p.kind === "literal"
			? new TextEncoder().encode(p.text).length
			: p.bound === "none"
				? undefined
				: textBoundsOf(boundTypes[p.bound])?.bytes
	)
	const known = Arr.filter(bytes, Predicate.isNotUndefined)
	return known.length === bytes.length ? Arr.reduce(known, 0, (sum, b) => sum + b) : undefined
}

/** The term's plain meaning over a row: its parts' texts joined in order, NULL where any is. */
export const termMeaningOf = (row: ReadonlyArray<string | null>): string | null => {
	const texts = textsOf(row)
	return texts === undefined ? null : Arr.join(texts, "")
}

/** A row's value of a term's column, NULL where it reads none. */
const termColumnOf = (row: ReadonlyArray<string | null>, name: string): string | undefined => {
	const at = Arr.findFirstIndex(
		Array.from({ length: row.length }, (_, i) => i),
		(i) => partColumn(i) === name
	)
	return Option.isSome(at) ? (row[at.value] ?? undefined) : undefined
}

/** The host's value of a lowered term over a row: its text or NULL (scalar/compute/evaluate.ts). */
export const termHostValueOf = (
	root: ScalarExpr,
	row: ReadonlyArray<string | null>
): string | null => {
	const value = hostValue(root, (name) => termColumnOf(row, name))
	return value === null ? null : textOf(value)
}

/** The reference evaluator's value of a lowered term over a row none of whose operands is NULL. */
export const termReferenceValueOf = (root: ScalarExpr, row: ReadonlyArray<string | null>): string =>
	textOf(referenceValue(root, (name) => termColumnOf(row, name)))

export type TermFeature =
	| "held by a query"
	| "refused in a query over a part no type bounds"
	| "refused in a query past the most bytes one varlena holds"
	| "exactly the most bytes one varlena holds"
	| "a concatenation nested in a concatenation"
	| "a literal part"
	| "a NULL operand"
	| "a character beyond the Basic Multilingual Plane"
	| "an empty part"

/** The situations a term reaches, by its shape, its parts and its bound. */
export const termFeatures = (c: TermCase): ReadonlyArray<TermFeature> => {
	const bytes = termBytes(c)
	return [
		...(bytes === undefined
			? ["refused in a query over a part no type bounds" as const]
			: bytes > byteaMaxLength
				? ["refused in a query past the most bytes one varlena holds" as const]
				: ["held by a query" as const]),
		...(bytes === byteaMaxLength ? ["exactly the most bytes one varlena holds" as const] : []),
		...(depthOf(c.shape) >= 2 ? ["a concatenation nested in a concatenation" as const] : []),
		...(Arr.some(c.parts, (p) => p.kind === "literal") ? ["a literal part" as const] : [])
	]
}

/** The situations a term's row reaches. */
export const termRowFeatures = (row: ReadonlyArray<string | null>): ReadonlyArray<TermFeature> => [
	...(termMeaningOf(row) === null ? ["a NULL operand" as const] : []),
	...(Arr.some(row, (r) => r !== null && Arr.some(Array.from(r), (ch) => ch.length > 1))
		? ["a character beyond the Basic Multilingual Plane" as const]
		: []),
	...(Arr.some(row, (r) => r === "") ? ["an empty part" as const] : [])
]
