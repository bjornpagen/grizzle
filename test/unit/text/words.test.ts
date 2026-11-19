/**
 * The IR's written-out languages (packages/text/src/regex/words.ts), each over drawn bounds and drawn digit strings
 * near them, every text read whole:
 *
 * - naturals(lo, hi) holds exactly the canonical decimal spellings (no leading zero but in 0 itself) of the naturals
 *   from lo to hi, and naturals(lo, "unbounded") those from lo on;
 * - digitRange(from, to) holds exactly the digit strings of their length from `from` to `to`, leading zeros digits like
 *   any other;
 * - literal(text) holds exactly the text, and runsOf(spec) exactly the code points its runs hold.
 *
 * Oracle: ECMAScript's RegExp test (test/support/regex.ts jsMatcher) of each language printed in grizzle's grammar
 * (print.ts printSource), against the definitions restated in bigint arithmetic over the text.
 *
 * Features: a text held and refused by each; an unbounded interval; an interval of one length and one across lengths
 * whose lengths between are whole; a text past every bound's length; an empty interval.
 */

import { end, type RegexNode, seq, set, start } from "@bjornpagen/grizzle-text/regex/ir"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import { digitRange, literal, naturals, runsOf } from "@bjornpagen/grizzle-text/regex/words"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { jsMatcher } from "#test/support/regex.ts"

type WordsFeature =
	| "naturals held"
	| "naturals refused"
	| "an unbounded interval"
	| "an interval of one length"
	| "an interval across three lengths or more"
	| "an empty interval"
	| "a text longer than every bound"
	| "a whole length one run"
	| "digitRange held"
	| "digitRange refused"
	| "literal held"
	| "runsOf held"
	| "runsOf refused"

interface WordsCase {
	readonly lo: bigint
	readonly hi: bigint | "unbounded"
	readonly texts: ReadonlyArray<string>
	readonly range: { readonly from: string; readonly to: string }
	readonly rangeTexts: ReadonlyArray<string>
	readonly literal: string
	readonly runs: RunsCase
	readonly points: ReadonlyArray<string>
}

/** A spelling of runs and the code points it holds, stated by hand. */
interface RunsCase {
	readonly spec: string
	readonly holds: (point: string) => boolean
}

const between =
	(lo: string, hi: string) =>
	(point: string): boolean =>
		point >= lo && point <= hi

/** Spellings of runs, each with its code points stated apart from runsOf's reading: a hyphen at an end is itself. */
const runsCases: Arr.NonEmptyReadonlyArray<RunsCase> = [
	{ spec: "0-9", holds: between("0", "9") },
	{
		spec: "a-zA-Z0-9+/",
		holds: (p) =>
			between("a", "z")(p) || between("A", "Z")(p) || between("0", "9")(p) || p === "+" || p === "/"
	},
	{ spec: "+-", holds: (p) => p === "+" || p === "-" },
	{ spec: "-a", holds: (p) => p === "-" || p === "a" },
	{ spec: "a-", holds: (p) => p === "a" || p === "-" },
	{ spec: "x", holds: (p) => p === "x" }
]

/** A digit string of 1 to `most` digits, its first digit any. */
const digitStringGen =
	(most: number): Gen<string> =>
	(source) => {
		const length = source.draw(int(1, most))
		return Arr.join(
			Array.from({ length }, () => String(source.draw(int(0, 9)))),
			""
		)
	}

/** A natural of 0 to 12 digits, drawn by its digit count first, so small and large bounds both appear. */
const naturalGen: Gen<bigint> = (source) =>
	source.draw(boolean) ? BigInt(source.draw(int(0, 120))) : BigInt(source.draw(digitStringGen(12)))

/** A text near `n`: its spelling, it plus or minus one, with a leading zero, a sign or a ninth digit more. */
const nearGen =
	(n: bigint): Gen<string> =>
	(source) => {
		const shown = n.toString()
		return source.draw(
			element([
				shown,
				(n + 1n).toString(),
				n > 0n ? (n - 1n).toString() : "0",
				`0${shown}`,
				`-${shown}`,
				`${shown}9`,
				Str.slice(1)(shown),
				`${shown}x`
			])
		)
	}

const wordsCaseGen: Gen<WordsCase> = (source) => {
	const a = source.draw(naturalGen)
	const b = source.draw(naturalGen)
	const [small, big] = a <= b ? [a, b] : [b, a]
	const empty = small < big && source.draw(int(0, 9)) === 0
	const lo = empty ? big : small
	const hi = empty ? small : source.draw(int(0, 4)) === 0 ? "unbounded" : big
	const near = [lo, ...(hi === "unbounded" ? [] : [hi])]
	const texts = [
		...Arr.map(near, (n) => source.draw(nearGen(n))),
		...source.draw(array(digitStringGen(14), { min: 3, max: 8 }))
	]
	const width = source.draw(int(1, 6))
	const pad = (s: string): string => Str.slice(-width)(Str.padStart(width, "0")(s))
	const x = pad(source.draw(digitStringGen(width)))
	const y = pad(source.draw(digitStringGen(width)))
	const [from, to] = x <= y ? [x, y] : [y, x]
	const rangeTexts = [
		from,
		to,
		...Arr.map(source.draw(array(digitStringGen(width), { min: 3, max: 8 })), pad),
		source.draw(digitStringGen(width + 1))
	]
	return {
		lo,
		hi,
		texts,
		range: { from, to },
		rangeTexts,
		literal: source.draw(element(["", "0", "a-b", "é", "\u{1F600}x"])),
		runs: source.draw(element(runsCases)),
		points: source.draw(
			array(element(["0", "5", "a", "z", "Q", "+", "/", "-", "x", "_"]), { min: 3, max: 6 })
		)
	}
}

/** Whether a node holds a whole text, by ECMAScript's test of the node printed in grizzle's grammar. */
const holds = (node: RegexNode): ((text: string) => boolean) => {
	const whole = seq([start, node, end])
	return whole.kind === "never"
		? () => false
		: jsMatcher(
				printSource(whole, (s) => s),
				"u"
			)
}

/** Whether every character of a text is a decimal digit. */
const isDigits = (text: string): boolean => Arr.every(Str.split(text, ""), between("0", "9"))

/** Whether a text is a natural's canonical decimal spelling: digits, no leading zero but in 0 itself. */
const isCanonical = (text: string): boolean =>
	text.length > 0 && isDigits(text) && (text === "0" || !Str.startsWith("0")(text))

/** The IR's written-out languages hold exactly the texts their definitions state. */
export const theIRsWrittenOutLanguagesHoldExactlyTheNaturalsDigitRangesTextsAndRunsTheyName =
	property.explore(wordsCaseGen, {
		needs: {},
		situations: [
			"naturals held",
			"naturals refused",
			"an unbounded interval",
			"an interval of one length",
			"an interval across three lengths or more",
			"an empty interval",
			"a text longer than every bound",
			"a whole length one run",
			"digitRange held",
			"digitRange refused",
			"literal held",
			"runsOf held",
			"runsOf refused"
		] satisfies ReadonlyArray<Reached<WordsFeature>>,
		check: (_, c: Case<WordsFeature>) => (k) =>
			Effect.sync(() => {
				const shown = `naturals(${k.lo}, ${k.hi})`
				const ofNaturals = holds(naturals(k.lo, k.hi))
				if (k.hi === "unbounded") {
					c.note("an unbounded interval")
				} else if (k.hi < k.lo) {
					c.note("an empty interval")
				} else if (k.lo.toString().length === k.hi.toString().length) {
					c.note("an interval of one length")
				} else if (k.hi.toString().length - k.lo.toString().length >= 2) {
					c.note("an interval across three lengths or more")
				}
				for (const text of k.texts) {
					const value = isCanonical(text) ? BigInt(text) : undefined
					const held =
						value !== undefined && value >= k.lo && (k.hi === "unbounded" || value <= k.hi)
					assert.equal(ofNaturals(text), held, `${shown} over ${Formatter.format(text)}`)
					c.note(held ? "naturals held" : "naturals refused")
					if (
						k.hi !== "unbounded" &&
						text.length > k.hi.toString().length &&
						text.length > k.lo.toString().length
					) {
						c.note("a text longer than every bound")
					}
				}
				const power = 10n ** BigInt(k.range.from.length - 1)
				const run = naturals(power, "unbounded")
				assert.ok(run.kind !== "never", "the naturals from a power of ten hold a natural")
				assert.ok(
					!Str.includes("|")(printSource(run, (s) => s)),
					`naturals(${power}, "unbounded") is one run of a nonzero digit and any digits, no alternation`
				)
				c.note("a whole length one run")
				const ofRange = holds(digitRange(k.range.from, k.range.to))
				for (const text of k.rangeTexts) {
					const held =
						isDigits(text) &&
						text.length === k.range.from.length &&
						text >= k.range.from &&
						text <= k.range.to
					assert.equal(
						ofRange(text),
						held,
						`digitRange(${k.range.from}, ${k.range.to}) over ${Formatter.format(text)}`
					)
					c.note(held ? "digitRange held" : "digitRange refused")
				}
				assert.ok(holds(literal(k.literal))(k.literal), `literal(${Formatter.format(k.literal)})`)
				assert.equal(
					holds(literal(k.literal))(`${k.literal}x`),
					false,
					"literal holds its text alone"
				)
				c.note("literal held")
				const ofRuns = holds(set(runsOf(k.runs.spec)))
				for (const point of k.points) {
					const held = k.runs.holds(point)
					assert.equal(
						ofRuns(point),
						held,
						`runsOf(${Formatter.format(k.runs.spec)}) over ${point}`
					)
					c.note(held ? "runsOf held" : "runsOf refused")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's RegExp test of each language printed in grizzle's grammar, against bigint and string comparisons over the text"
		},
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/words.ts",
				original: "\t\t\t\t\t...(d < 9 ? [seq([digitsFrom(d + 1, 9), anyDigits(b, rest)])] : [])",
				replacement:
					"\t\t\t\t\t...(d < 8 ? [seq([digitsFrom(d + 2, 9), anyDigits(b, rest)])] : [])",
				why: "atLeast skips the digit after a bound's own: a natural one place up at that digit is refused."
			},
			{
				file: "packages/text/src/regex/words.ts",
				original: '\t\treturn b.alt([...zeroArm, ...lower, lengths(firstRun, "unbounded")])',
				replacement: '\t\treturn b.alt([...zeroArm, ...lower, lengths(firstRun + 1, "unbounded")])',
				why: "An unbounded interval skips the length after its least's: every natural one digit longer is refused."
			},
			{
				file: "packages/text/src/regex/words.ts",
				original: "\t\t...(firstRun <= lastRun ? [lengths(firstRun, lastRun)] : []),",
				replacement: "\t\t...(firstRun < lastRun ? [lengths(firstRun, lastRun)] : []),",
				why: "An interval drops its one length all of whose naturals it holds: a natural of that length is refused."
			},
			{
				file: "packages/text/src/regex/words.ts",
				original: '\tconst leastWhole = allOf(least.slice(1), 0) && least.startsWith("1")',
				replacement:
					'\tconst leastWhole = allOf(least.slice(1), 0) && least.startsWith("1") && false',
				why: "A least that is its length's least natural keeps a range of its own beside the run of the lengths above it: the naturals from a power of ten print as an alternation."
			}
		]
	})
