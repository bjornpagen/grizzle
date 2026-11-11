/**
 * The naming door's byte limit on declared names (core/identity.ts parseDeclaredName): a declared name is admitted
 * exactly when its conversion, its segments lowercased and joined by single underscores, fits maxIdentifierBytes, and
 * an admitted name names its table by exactly that conversion, never cut. The oracle is the generator's own segments:
 * a name is spelled from words, acronyms and digit runs, each run of them joined so the door's boundary rule splits it
 * back into them (a capital after a lowercase letter, an acronym's last capital before a lowercase letter, a digit run
 * against a letter, an underscore), so the conversion is known before the door reads it. Lengths are steered to the
 * limit: a name's conversion ends at a drawn target byte count around 63, the last word sized to meet it.
 *
 * Features: a conversion under the limit, at it, one byte past and far past, and two names at the limit apart.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): declared-names-at-limit-refused (a conversion of exactly the limit
 * refused) and declared-names-acronym-unsplit (an acronym's last capital kept with it before a lowercase letter).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { characterOf, element, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import {
	conversionOf,
	identity,
	maxIdentifierBytes,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const lowercase = nonEmpty(Arr.fromIterable("abcdefghijklmnopqrstuvwxyz"), "lowercase letters")
const uppercase = nonEmpty(Arr.fromIterable("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "capital letters")
const digits = nonEmpty(Arr.fromIterable("0123456789"), "digits")

/** A segment as declared and as its conversion spells it. */
interface Segment {
	readonly declared: string
	readonly converted: string
}

/** A word: a capital and `length - 1` lowercase letters. */
const wordOf =
	(length: number): Gen<Segment> =>
	(source) => {
		const declared = `${source.draw(characterOf(uppercase))}${source.draw(string(characterOf(lowercase), { min: length - 1, max: length - 1 }))}`
		return { declared, converted: Str.toLowerCase(declared) }
	}

/** A run of two to four capitals, which a following word's capital ends. */
const acronym: Gen<Segment> = (source) => {
	const declared = source.draw(string(characterOf(uppercase), { min: 2, max: 4 }))
	return { declared, converted: Str.toLowerCase(declared) }
}

/** A run of one to three digits. */
const digitRun: Gen<Segment> = (source) => {
	const declared = source.draw(string(characterOf(digits), { min: 1, max: 3 }))
	return { declared, converted: declared }
}

type Kind = "word" | "acronym" | "digits"

/**
 * How a segment joins the one before it: an underscore always splits; with nothing between, the boundary rule must
 * split them, which it does unless both are digit runs or both acronyms, or an acronym runs into a digit-free acronym.
 */
const joined = (before: Kind, after: Kind, underscore: boolean): string =>
	underscore || (before === after && before !== "word") ? "_" : ""

/** A declared name of words, acronyms and digit runs whose conversion is `target` bytes, its first segment a word. */
const nameOf =
	(target: number): Gen<{ readonly declared: string; readonly converted: string }> =>
	(source) => {
		const first = source.draw(wordOf(source.draw(int(2, 8))))
		let declared = first.declared
		const converted: Array<string> = [first.converted]
		let before: Kind = "word"
		const length = () => Arr.reduce(converted, converted.length - 1, (n, s) => n + s.length)
		while (target - length() > 12) {
			const kind = source.draw(element(["word", "acronym", "digits"] as const))
			const segment = source.draw(
				kind === "word" ? wordOf(source.draw(int(2, 8))) : kind === "acronym" ? acronym : digitRun
			)
			declared += `${joined(before, kind, source.draw(element([false, true] as const)))}${segment.declared}`
			converted.push(segment.converted)
			before = kind
		}
		const last = source.draw(wordOf(Math.max(2, target - length() - 1)))
		declared += `${joined(before, "word", source.draw(element([false, true] as const)))}${last.declared}`
		converted.push(last.converted)
		return { declared, converted: Arr.join(converted, "_") }
	}

/** A conversion's length around the limit: mostly within two bytes of it, sometimes well under or past. */
const targetGen: Gen<number> = weighted<number>([
	[4, int(maxIdentifierBytes.value - 2, maxIdentifierBytes.value + 2)],
	[1, int(20, maxIdentifierBytes.value + 12)]
])

type LimitFeature =
	| "under the limit"
	| "at the limit"
	| "one byte past"
	| "far past"
	| "two at the limit apart"

const situationOf = (bytes: number): LimitFeature =>
	bytes < maxIdentifierBytes.value
		? "under the limit"
		: bytes === maxIdentifierBytes.value
			? "at the limit"
			: bytes === maxIdentifierBytes.value + 1
				? "one byte past"
				: "far past"

describe("the naming door's byte limit", () => {
	it.effect(
		"admits a declared name exactly when its conversion fits, and names its table by that conversion, whole",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/kernel/declared-name-limit",
						draw: drawn(
							(source) =>
								[
									source.draw(nameOf(source.draw(targetGen))),
									source.draw(nameOf(source.draw(targetGen)))
								] as const
						),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the generator's own segments, lowercased and joined by underscores, and the limit on their bytes"
						},
						coverage: required<LimitFeature>(
							[
								"under the limit",
								"at the limit",
								"one byte past",
								"far past",
								"two at the limit apart"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(names, c) =>
						Effect.sync(() => {
							const identifiers = Arr.map(names, ({ declared, converted }) => {
								assert.equal(conversionOf(declared), converted, declared)
								const bytes = Buffer.byteLength(converted)
								c.note(situationOf(bytes))
								const parsed = parseDeclaredName(declared)
								assert.equal(parsed.ok, bytes <= maxIdentifierBytes.value, declared)
								if (!parsed.ok) {
									return undefined
								}
								const table = identity.table(parsed.value)
								assert.equal(table.form, "readable", declared)
								assert.equal<string>(table.identifier, converted, declared)
								return table.identifier
							})
							const [[a, b], [x, y]] = [names, identifiers]
							if (x !== undefined && y !== undefined) {
								assert.equal(
									x === y,
									a.converted === b.converted,
									`${a.declared} beside ${b.declared}`
								)
								if (
									x !== y &&
									Buffer.byteLength(x) === maxIdentifierBytes.value &&
									Buffer.byteLength(y) === maxIdentifierBytes.value
								) {
									c.note("two at the limit apart")
								}
							}
						})
				)
			)
	)
})
