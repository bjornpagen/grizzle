/**
 * A text's equation with a concatenation of any number of parts, `t = p1 || … || pn` (scalar/compute/typing.ts
 * concatEquation): its concatenation's nested concatenations read through as its parts, decided by the parts' lengths,
 * p1 as t's prefix, each middle part at the sum of the lengths before it (the infix test, `substring(t, o + 1,
 * char_length(pi)) = pi`) and pn as t's suffix, with no text built, in a query as in a check.
 *
 * - Property: over equations of two to five parts drawn as concatenation trees of any bracketing (concat-equation.
 *   fixtures.ts), each part a text column, bounded or not, a bare literal, a translation a query refuses or an integer
 *   column, the whole a column or a literal on either side, `=` or `<>`: at each site, the equation compiles exactly
 *   when every part's two-part analogue does, the part at its own place beside a column every site lowers, and a
 *   refusal is one an analogue gives; where it compiles, the host's value of the lowered equation over drawn rows
 *   (texts of one-, two- and four-byte characters, empty ones and NULL) is its plain meaning, three-valued, and the
 *   reference evaluator's is too where no operand is NULL.
 *
 * Oracle: the equation's plain meaning, the whole against the parts' texts joined in order, NULL at a NULL operand;
 * and, for what compiles, the two-part equation, whose lowering decides it.
 *
 * Features: two to five parts, a concatenation nested two deep and in a second operand, an equation that holds, one
 * whose lengths hold and whose middle part differs, a NULL operand, multibyte and empty parts, and a refusal in a query
 * alone and at every site.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	analogueDesc,
	anyEquationGen,
	type EquationFeature,
	equationDesc,
	hostValueOf,
	loweredAt,
	meaningOf,
	readsNull,
	referenceValueOf,
	rowFeatures,
	shapeFeatures
} from "#test/unit/compute/concat-equation.fixtures.ts"

/**
 * An equation of a text with a concatenation of any number of parts compiles exactly where its two-part analogues do,
 * at each site, and means the whole is the parts in order.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anEquationWithAConcatenationOfAnyNumberOfPartsCompilesExactlyWhereItsTwoPartAnaloguesDoAndMeansTheWholeIsThePartsInOrder =
	property.explore(anyEquationGen, {
		needs: {},
		situations: [
			"two parts",
			"three parts",
			"four parts",
			"five parts",
			"a concatenation nested two deep",
			"a concatenation nested in a second operand",
			"the equation holds",
			"the lengths hold and a middle part differs",
			"a NULL operand",
			"a part of multibyte characters",
			"an empty part",
			"refused in a query alone",
			"refused at every site"
		] satisfies ReadonlyArray<Reached<EquationFeature>>,
		check: (_, k: Case<EquationFeature>) => (c) =>
			Effect.sync(() => {
				const label = Formatter.format({
					parts: c.parts,
					shape: c.shape,
					whole: c.whole,
					mirrored: c.mirrored,
					ne: c.ne
				})
				const compiled = Arr.map(["check", "query"] as const, (mode) => {
					const lowered = loweredAt(mode, c, equationDesc(c))
					const analogues = Arr.map(c.parts, (_, i) => loweredAt(mode, c, analogueDesc(c, i)))
					const refusals = Arr.flatMap(analogues, (a) => (a.ok ? [] : [a.error.reason._tag]))
					assert.equal(
						lowered.ok,
						refusals.length === 0,
						`${mode}: compiles exactly where every two-part analogue does: ${label}`
					)
					if (!lowered.ok) {
						assert.ok(
							Arr.contains(refusals, lowered.error.reason._tag),
							`${mode}: refused as an analogue is, ${lowered.error.reason._tag} among ${Formatter.format(refusals)}: ${label}`
						)
					}
					return lowered
				})
				const [check, query] = compiled
				if (!defined(check, "the check's lowering").ok) {
					k.note("refused at every site")
					return
				}
				const inQuery = defined(query, "the query's lowering")
				if (!inQuery.ok) {
					k.note("refused in a query alone")
				}
				for (const feature of shapeFeatures(c)) {
					k.note(feature)
				}
				for (const lowered of compiled) {
					if (!lowered.ok) {
						continue
					}
					const root = lowered.value.root.expr
					for (const row of c.rows) {
						const meaning = meaningOf(c, row)
						const where = `${Formatter.format(row)}: ${label}`
						assert.equal(
							hostValueOf(c, root, row),
							meaning,
							`the host's value is the meaning over ${where}`
						)
						if (!readsNull(c, row)) {
							assert.equal<unknown>(
								referenceValueOf(c, root, row),
								meaning,
								`the reference evaluator's is the meaning over ${where}`
							)
						}
						for (const feature of rowFeatures(c, row)) {
							k.note(feature)
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the equation's plain meaning, the whole against the parts' texts joined in order and NULL at a NULL operand; and the two-part equations, whose lowering decides each part"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\tif (desc.kind !== "compute" || desc.fn !== "concat") {\n\t\treturn [{ desc, at, concat, stands }]',
				replacement:
					'\tif (desc.kind !== "compute" || desc.fn !== "concat" || at === at) {\n\t\treturn [{ desc, at, concat, stands }]',
				why: "Flattening is capped at two parts: a concatenation nested in an equation's side is one part, typed as a term, which a query refuses beside an equation (concat in a query), where every two-part analogue compiles."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t\t\tthis.literal(1, plainType("int4"), here),',
				replacement: '\t\t\t\t\tthis.literal(0, plainType("int4"), here),',
				why: "A middle part is read one character early, at the sum of the lengths before it counted from 1 as from 0, so a whole that is the parts in order is refused wherever a part before it is not empty."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\t\t\tthis.overload("charLength", [x.actual], here),',
				replacement: '\t\t\t\tthis.overload("octetLength", [x.actual], here),',
				why: "The lengths are bytes, not characters, so a middle part after a multibyte one is read at a byte count of characters, past its place."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: '\t\tconst guard: GuardDesc = { kind: "within", low: 1n, high }',
				replacement: '\t\tconst guard: GuardDesc = { kind: "within", low: high, high }',
				why: "The guard a fourth part's start stands under holds at int4's greatest value alone, so the part is read only through its false, and a whole that is five parts in order is refused."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\t\tsubstringOf(hostOf("text", a(args)), start(b(args)), BigInt(Array.from(part).length)) ===',
				replacement:
					'\t\t\t\t\tsubstringOf(hostOf("text", a(args)), start(b(args)), BigInt(part.length)) ===',
				why: "The host's infix test reads a part's UTF-16 code units for its characters, so a part holding a character past the Basic Multilingual Plane reads one character too many."
			}
		]
	})
