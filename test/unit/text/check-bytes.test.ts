/**
 * The bytes a text refinement's check prints in, as the text analysis states them without the printer
 * (text/refinement.ts predicateBytes, over its spelling data checkSpelling), are the bytes the printer prints the
 * check's membership predicate over a domain's VALUE in (text/membership.ts membership, sql/print.ts printExpr): what
 * the analysis chooses between a finite language's `VALUE IN (...)` and its AREs by, so the choice is the one the
 * printed statement's size decides, and a contract's parser, which runs the analysis where it is built, loads no SQL
 * printer.
 *
 * The space: a finite check of one to four members and a regex check of one to three AREs, each text drawn from
 * characters that print alike and unlike their bytes: ASCII, a quote the printer doubles, a two-byte, a three-byte and a
 * four-byte character, and a backslash, which the printer leaves as it is.
 *
 * Oracle: second implementation, the printer's text of the predicate.
 */

import { textBounds } from "@bjornpagen/grizzle-text/regex/dfa"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, characterOf, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { finiteCheck, type PatternCheck, regexCheck } from "#compiler/ir/scalar.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { domainValue, membership } from "#compiler/text/membership.ts"
import { predicateBytes } from "#compiler/text/refinement.ts"

type Situation = "a finite check" | "a regex check" | "a text holding a quote"

/** A text of up to six characters, each one the printer prints alike or unlike its bytes. */
const texts: Gen<string> = (source) =>
	Arr.join(source.draw(array(characterOf(["a", "'", "é", "€", "𝄞", "\\"]), { min: 0, max: 6 })), "")

const checks: Gen<PatternCheck> = (source) => {
	const finite = source.draw(int(0, 1)) === 0
	const [first, ...rest] = source.draw(array(texts, { min: 1, max: finite ? 4 : 3 }))
	const items: Arr.NonEmptyReadonlyArray<string> = [first ?? "", ...rest]
	return finite ? finiteCheck(items, textBounds(6, 24)) : regexCheck(items, undefined)
}

/** Each text a check prints a literal of. */
const textsOf = (check: PatternCheck): ReadonlyArray<string> =>
	check.kind === "finite" ? check.members : check.ares

/** The bytes the analysis states a check prints in are the printer's. */
export const aChecksStatedBytesAreThePrintersBytesOfItsPredicate = property.explore(checks, {
	needs: {},
	budget: { runs: 200, steered: 100 },
	situations: ["a finite check", "a regex check", "a text holding a quote"] satisfies ReadonlyArray<
		Reached<Situation>
	>,
	check: (_, c: Case<Situation>) => (check: PatternCheck) =>
		Effect.sync(() => {
			c.note(check.kind === "finite" ? "a finite check" : "a regex check")
			if (Arr.some(textsOf(check), Str.includes("'"))) {
				c.note("a text holding a quote")
			}
			assert.equal(
				predicateBytes(check),
				utf8Length(printExpr(membership(check, domainValue))),
				Formatter.format(check)
			)
		}),
	oracle: { kind: "second-implementation", name: "the printer's text of the check's predicate" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/text/refinement.ts",
			original: '\t(text.split(checkSpelling.quote).length - 1) * spelled("quote") +\n',
			replacement: "",
			why: "A quote inside a literal counts once, where the printer doubles it: a text holding a quote prints in more bytes than the analysis states."
		},
		{
			file: "packages/engine/src/text/refinement.ts",
			original: '\ttextCast: \'::"pg_catalog"."text"\'\n',
			replacement: "\ttextCast: '::text'\n",
			why: "The literal's cast is stated shorter than the printer prints it: every check prints in more bytes than the analysis states."
		}
	]
})
