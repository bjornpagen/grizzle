/** What the properties of differential.test.ts read: the families' cases and agreement, and the edges of the limits. */
import * as RegexIr from "@bjornpagen/grizzle-text/regex/ir"
import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { regexMaxRepeat } from "@bjornpagen/grizzle-text/regex/parse"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { type Case, type Kill, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import { everyProperty } from "#compiler/core/canonical.ts"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import { domainDigest } from "#compiler/core/fingerprint.ts"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { admitIr } from "#compiler/ir/pattern.ts"
import { createDomain } from "#compiler/physical/ddl/domains.ts"
import { emit, costChosen } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import {
	analyzeText,
	type TextRefinement,
	textDomainDefinition
} from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { pickGen } from "#test/support/pick.ts"
import { jsMatcher } from "#test/support/regex.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import {
	type Family,
	type Flags,
	families,
	flagsGen,
	nestedPattern,
	patternOver,
	stringsOver,
	walk,
	walkGen,
	walkLength,
	walkTape
} from "#test/support/unit/text/generators.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * What refuses a count of a shape, so that PostgreSQL is handed no ARE of it: the limit of PostgreSQL's regex compiler
 * it crosses; an IR no text matches, which every reader of an admitted pattern refuses in place of an ARE (admit.ts
 * admitMatch, text/refinement.ts analyzeText); or another refusal.
 */
type EdgeRefusal = RegexSpaceMeasure["kind"] | "no text" | "another refusal"

/**
 * What an edge search reached: the refusal past its largest admitted count, the shape's greatest count itself, or a
 * shape refused at its first count, which has no edge to compile.
 */
export type EdgeFeature = EdgeRefusal | "the shape's top" | "a shape refused at its first count"

/**
 * A shape a pattern grows along, from count 1 to `top`, each count's pattern its source: the limits of PostgreSQL's
 * regex compiler bind along one of them, or none does by the top.
 */
interface Growth {
	readonly at: (n: number) => string
	readonly top: number
}

/**
 * A count's pattern as PostgreSQL is handed it: admitted (ir/pattern.ts admitIr) with an IR some text matches, and the
 * NFA its host membership reads.
 */
interface LivePattern {
	readonly ir: RegexIr.LiveNode
	readonly nfa: Nfa
}

/** A count's pattern, admitted with an IR some text matches, or what refuses it. */
type Measured =
	| { readonly kind: "admitted"; readonly pattern: LivePattern }
	| { readonly kind: "refused"; readonly refusal: EdgeRefusal }

export const measureAt = (growth: Growth, n: number): Measured => {
	const r = admitIr(growth.at(n), "u")
	if (!r.ok) {
		return {
			kind: "refused",
			refusal: r.error.kind === "compileSpace" ? r.error.measure.kind : "another refusal"
		}
	}
	const ir = r.value
	return ir.kind === "never"
		? { kind: "refused", refusal: "no text" }
		: { kind: "admitted", pattern: { ir, nfa: buildNfa(ir) } }
}

/** The largest count admitted from an admitted 1, its pattern, and what refuses the count past it. */
interface Edge {
	readonly greatest: number
	readonly pattern: LivePattern
	readonly past: EdgeFeature
}

/** The edge from count 1's admitted pattern, by bisection over 1 to the shape's top. */
export const edgeAt = (growth: Growth, first: LivePattern): Edge => {
	const top = measureAt(growth, growth.top)
	if (top.kind === "admitted") {
		return { greatest: growth.top, pattern: top.pattern, past: "the shape's top" }
	}
	let low = { greatest: 1, pattern: first }
	let high = growth.top
	let past: EdgeRefusal = top.refusal
	while (high - low.greatest > 1) {
		const middle = Math.floor((low.greatest + high) / 2)
		const measured = measureAt(growth, middle)
		switch (measured.kind) {
			case "admitted":
				low = { greatest: middle, pattern: measured.pattern }
				break
			case "refused":
				high = middle
				past = measured.refusal
				break
		}
	}
	return { ...low, past }
}

/** A code point as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/** Code points of three widths, so a drawn alphabet cuts the characters into many colors. */
const widePoint: Gen<number> = oneOf<number>([
	int(0x21, 0x7e),
	int(0x4e00, 0x9fff),
	int(0x1f300, 0x1faff)
])

/** A drawn body repeated `{inner}` times, then `{n}` or `{0,n}` times, anchored at both ends or followed by a literal. */
const repeatedOf =
	(body: Gen<string>): Gen<Growth> =>
	(source) => {
		const drawnBody = source.draw(body)
		const inner = source.draw(int(1, regexMaxRepeat))
		const exact = source.draw(boolean)
		const anchored = source.draw(boolean)
		return {
			at: (n) =>
				`${anchored ? "^" : ""}(?:(?:${drawnBody}){${inner}}){${exact ? n : `0,${n}`}}${anchored ? "$" : "b"}`,
			top: regexMaxRepeat
		}
	}

/** m code points of their own, then n copies of a class of all of them under a drawn quantifier: arcs by colors. */
const colorfulGen: Gen<Growth> = (source) => {
	const points = source.draw(uniqueKeys(widePoint, { min: 2, max: 2_048 }))
	const quantifier = source.draw(element(["", "?", "{0,255}", "{1,255}", "{255}", "*"]))
	const spelled = Arr.join(Arr.map(points, escaped), "")
	return { at: (n) => `${spelled}(?:[${spelled}]${quantifier}){${n}}b`, top: regexMaxRepeat }
}

/** An alternation of n hundred words of a drawn alphabet: the states a match reads, and colors as the alphabet is wide. */
const wordsGen: Gen<Growth> = (source) => {
	const points = source.draw(uniqueKeys(widePoint, { min: 10, max: 64 }))
	const length = source.draw(int(2, 6))
	const wordOf = (i: number): string =>
		Arr.join(
			upTo(length, (d) =>
				escaped(defined(points[Math.floor(i / points.length ** d) % points.length], "a point"))
			),
			""
		)
	return {
		at: (n) => `^(?:${Arr.join(upTo(n * 100, wordOf), "|")})$`,
		top: Math.min(Math.floor(points.length ** length / 100), 1_024)
	}
}

/** n times 64 nested optional groups, each a code point and the rest: the parser's recursion and the walks' depth. */
const nestingGen: Gen<Growth> = (source) => {
	const c = escaped(source.draw(widePoint))
	return { at: (n) => `${Str.repeat(n * 64)(`(?:${c}`)}${Str.repeat(n * 64)(")?")}b`, top: 1_024 }
}

/** An alternation of an anchor on either side of a wide class's counted run, n times, two anchors to move each time. */
const anchorsGen: Gen<Growth> = (source) => {
	const run = `${source.draw(element([".", "[a-z]", "\\W"]))}{1,${source.draw(int(1, regexMaxRepeat))}}`
	return { at: (n) => `(?:^|${run}|$){${n}}b`, top: 64 }
}

/** An alternation of n hundred two-character words, each a code point of its own and a common one: states times colors. */
const colorsGen: Gen<Growth> = (source) => {
	const base = source.draw(element([0x4e00, 0x20000]))
	return {
		at: (n) =>
			`^(?:${Arr.join(
				upTo(n * 100, (i) => `${escaped(base + i)}y`),
				"|"
			)})$`,
		top: 255
	}
}

/** A counted run of a nullable body, the shape whose empty paths copy arcs. */
const nullableNestGen: Gen<Growth> = repeatedOf(
	(source) =>
		`(?:${source.draw(element(["a|", "a|b?", "a?", "(?:a|)"]))}){${source.draw(int(2, regexMaxRepeat))}}`
)

/**
 * The limits a shape grows to the edge of: every one a count binds first, the colors and the states held at once
 * binding none the match's limits leave, and a loop through an anchor growing with no count.
 */
export const edgeLimits = [
	"depth",
	"arcs",
	"matchStates",
	"matchCells",
	"anchors"
] as const satisfies Arr.NonEmptyReadonlyArray<RegexSpaceMeasure["kind"]>
type EdgeLimit = (typeof edgeLimits)[number]

/** Each limit's shape, the one a case whose turn aims at that pending limit draws (edgeAims). */
const shapeOf: { readonly [K in EdgeLimit]: Gen<Growth> } = {
	depth: nestingGen,
	arcs: colorfulGen,
	matchStates: wordsGen,
	matchCells: colorsGen,
	anchors: anchorsGen
}

/** Each limit, with the shape a case whose turn aims at it draws (aimed). */
const edgeAims: ReadonlyArray<readonly [EdgeFeature, Gen<Growth>]> = Arr.map(
	edgeLimits,
	(kind) => [kind, shapeOf[kind]] as const
)

/** A drawn shape, each limit's among them. */
const growthGen: Gen<Growth> = weighted<Growth>([
	[2, repeatedOf(nestedPattern)],
	[2, colorfulGen],
	[1, colorsGen],
	[1, wordsGen],
	[1, nestingGen],
	[1, anchorsGen],
	[1, nullableNestGen]
])

const loc = (family: string, i: number) => SourceLoc("str.regex", [family, i])
/** A batch's randomized strings, and the generated patterns a case draws besides the family's own. */
const stringsPerCase = 500
const generatedPerFamily = 12
/** The accepting walks a case draws over a pattern's NFA, its own members besides its finite ones. */
const walksPerPattern = 24

/**
 * A pattern's refinement, a language with no admitted text value ("empty"), or a pattern past the limits ("bound").
 */
export const refine = (
	source: string,
	flags: Flags,
	at: SourceLoc
): TextRefinement | "empty" | "bound" => {
	const result = analyzeText([{ source, flags }], at)
	if (result.ok) {
		return result.value
	}
	if (result.error.reason._tag === "ResourceBound") {
		return "bound"
	}
	const parsed = parsePattern(source, flags)
	if (!parsed.ok) {
		throw new Error(`/${source}/${flags} does not parse: ${parsed.error.message}`)
	}
	if (parsed.value.kind === "never") {
		return "empty"
	}
	throw new Error(`/${source}/${flags}: ${result.error.message}`)
}

export const truth = (value: unknown): boolean => {
	if (value === "true") {
		return true
	}
	if (value === "false") {
		return false
	}
	throw new Error(`expected a boolean text, got ${String(value)}`)
}

/**
 * What a case of a family reached: a pattern enforced by an installed domain, a generated pattern admitted, a pattern
 * whose own member PostgreSQL's ARE and the domain accepted, one that refused a string of the batch, and a pattern whose
 * language is empty.
 */
type DifferentialFeature =
	| "domain enforced"
	| "generated pattern admitted"
	| "own member accepted"
	| "member refused"
	| "empty language"

/** Whether a refinement's own members are walked over its NFA: none where its members are finite or it has none. */
const walked = (r: TextRefinement | "empty" | "bound"): r is TextRefinement =>
	r !== "empty" && r !== "bound" && r.check.kind !== "finite"

/** The walks a case draws for a handwritten pattern's refinement: accepting walks over its NFA, where it is walked. */
const walksFor = (r: TextRefinement | "empty" | "bound"): Gen<ReadonlyArray<string | undefined>> =>
	walked(r)
		? array(walkGen(buildNfa(r.members[0].ir)), { min: 0, max: walksPerPattern })
		: constant([])

/** The tapes of a generated pattern's walks, drawn before its refinement is known, each a walk's choices. */
const walkTapes: Gen<ReadonlyArray<ReadonlyArray<number>>> = array(
	array(pickGen, { min: 0, max: walkTape }),
	{ min: 0, max: walksPerPattern }
)

/** A generated pattern's walks: its tapes walked over its NFA, built once, where its refinement is walked. */
const walksOf = (
	r: TextRefinement | "empty" | "bound",
	tapes: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<string | undefined> => {
	if (!walked(r)) {
		return []
	}
	const nfa = buildNfa(r.members[0].ir)
	return Arr.map(tapes, (tape) => walk(nfa, tape, walkLength))
}

/**
 * One drawn case of a family: the strings, the walks of each handwritten pattern, and generated patterns with the
 * tapes of their walks.
 */
interface FamilySketch {
	readonly strings: ReadonlyArray<string>
	readonly handwritten: ReadonlyArray<ReadonlyArray<string | undefined>>
	readonly generated: ReadonlyArray<{
		readonly source: string
		readonly flags: Flags
		readonly tapes: ReadonlyArray<ReadonlyArray<number>>
	}>
}

/**
 * One pattern of a case: its text, whether a person wrote it, its refinement, its drawn walks, and its ECMAScript
 * membership, compiled once.
 */
interface CasePattern {
	readonly source: string
	readonly flags: Flags
	readonly handwritten: boolean
	readonly r: TextRefinement | "empty" | "bound"
	readonly walks: ReadonlyArray<string | undefined>
	readonly ecma: (value: string) => boolean
}

/** A resolved case of a family: its strings, and every pattern it asks about them. */
interface FamilyCase {
	readonly strings: ReadonlyArray<string>
	readonly patterns: ReadonlyArray<CasePattern>
}

/**
 * The family's agreement on one drawn case, in the case's transaction of `db` (Substrate.rolledBack), which the case's
 * domains are created in and which is rolled back when the case ends.
 */
const agreeOn = (
	db: CaseSession,
	schema: string,
	fi: number,
	family: Family,
	patterns: ReadonlyArray<CasePattern>,
	strings: ReadonlyArray<string>,
	note: (feature: DifferentialFeature) => void
) =>
	Effect.gen(function* () {
		for (const [pi, { source, flags, handwritten, r, walks, ecma }] of patterns.entries()) {
			const label = `${family.name} /${source}/${flags}`
			if (r === "bound") {
				assert.equal(handwritten, false, `${label} exceeds the limits`)
				continue
			}
			if (!handwritten && r !== "empty") {
				note("generated pattern admitted")
			}
			/**
			 * The batch's strings, and the pattern's own members: its finite members, or the distinct strings of its
			 * drawn accepting walks, so no pattern is only ever asked to refuse.
			 */
			const own =
				r === "empty"
					? []
					: r.check.kind === "finite"
						? [...r.check.members]
						: [...new Set(Arr.flatMap(walks, (w) => (w === undefined ? [] : [w])))]
			const all = ["", ...strings, ...own]
			const js = Arr.map(all, ecma)
			if (r === "empty") {
				note("empty language")
				assert.equal(
					Arr.some(js, (x) => x),
					false,
					label
				)
				continue
			}
			const host = Arr.map(all, (v) => accepts(r, v))
			const slug = `f${fi}_p${pi}`
			const named = identity.textDomain(domainDigest({ slug }, everyProperty))
			const name = named.identifier
			let domainType = "text"
			if (r.check.kind !== "tautology") {
				const statement = createDomain(
					textDomainDefinition(r.check),
					{ schema, name },
					() => identity.domainCheck(named).identifier
				)
				const ddl = succeeded(emit(statement, emptyNameMap, costChosen)).text
				yield* db.query(ddl, [])
				domainType = `${quoteIdent(schema)}.${quoteIdent(name)}`
				note("domain enforced")
			}
			const payload = jsonText(Arr.map(all, (v, ord) => ({ ord, v })))
			const rows = yield* db.values(
				`SELECT (c.v COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text, pg_input_is_valid(c.v, $3::text)::text
					 FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
				[payload, r.members[0].are, domainType]
			)
			assert.equal(rows.length, all.length, label)
			for (const [i, row] of rows.entries()) {
				const value = Formatter.format(all[i])
				const expected = defined(js[i], `the ECMAScript answer on ${value}`)
				assert.equal(
					defined(host[i], `the host answer on ${value}`),
					expected,
					`${label} host on ${value}`
				)
				assert.equal(truth(row[0]), expected, `${label} ARE ${r.members[0].are} on ${value}`)
				assert.equal(truth(row[1]), expected, `${label} domain on ${value}`)
			}
			assert.equal(Arr.every(own, ecma), true, `${label} witnesses are members`)
			if (own.length > 0) {
				note("own member accepted")
			}
			if (Arr.some(js, (x) => !x)) {
				note("member refused")
			}
		}
	})

/**
 * The limits of PostgreSQL's regex compiler grizzle holds a pattern to (ir/pattern-space.ts) must keep every
 * admitted pattern inside what PostgreSQL 19 compiles: it refuses none of them as too complex or for too many
 * colors. How long a compile takes is no part of the property, since the machine's load sets it; a compile that
 * never ends is a hang, which the case's deadline reports.
 */
export const compileWithin = (db: CaseSession, are: string) =>
	db.query("SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text", [are])

/** The at-limit search's space: a growth along a drawn shape, aimed at each limit's edge. */
export const growthSpace = aimed(growthGen, edgeAims)

/** How an at-limit case prints: its pattern at the first count, cut to 160 characters. */
export const showGrowth = (growth: Growth): string =>
	Formatter.format(Str.slice(0, 160)(growth.at(1)))

/**
 * One family's agreement: its own patterns, refined and compiled once (a handwritten pattern past the limits fails the
 * module's load), beside generated ones over its alphabet, against batches of its strings, each case its own schema
 * and owner session on its own database.
 */
/** The end anchor's translation to ARE (scalar/regex/are.ts), which a family whose patterns end at an anchor catches. */
const endAnchorKill: Kill = {
	file: "packages/text/src/regex/print.ts",
	original: '\tanchors: { start: "\\\\A", end: "\\\\Z" }',
	replacement: '\tanchors: { start: "\\\\A", end: "(?=\\\\n?\\\\Z)" }',
	why: "The end anchor translated as matching before a final newline."
}

/** `\d` read as holding the Arabic-Indic digits beside ASCII's, as Unicode's decimal digits would have it. */
const unicodeDigitKill: Kill = {
	file: "packages/text/src/regex/charset.ts",
	original: "export const digit: CharSet = charSet([[0x30, 0x39]])",
	replacement: "export const digit: CharSet = charSet([[0x30, 0x39], [0x660, 0x669]])",
	why: "\\d holds the Arabic-Indic digits, which ECMAScript's \\d under the u flag does not; a non-ASCII digit's membership disagrees."
}

/** A negated class compiled as the class it negates. */
const negationDroppedKill: Kill = {
	file: "packages/text/src/regex/parse.ts",
	original: "\t\treturn Ir.set(negated ? complement(members) : members)",
	replacement: "\t\treturn Ir.set(members)",
	why: "A negated class's complement is dropped, so [^a] holds a; a negated class's membership disagrees."
}

/** Printable ASCII punctuation from ! to / taken for alphanumerics and printed bare in the ARE, where it is an operator. */
const punctuationBareKill: Kill = {
	file: "packages/text/src/regex/print.ts",
	original: "\tisAsciiDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)",
	replacement: "\t(c >= 0x21 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)",
	why: "A literal . * + ( ) prints without its backslash, so PostgreSQL reads an operator; an escaped literal's membership disagrees."
}

/**
 * The kills a family's agreement catches, by the family's name: the end-anchor bug is caught by the families whose
 * strings and patterns meet a final newline at an end anchor; the digit, negation and punctuation bugs by the family
 * whose patterns and strings meet them.
 */
const familyKills: Readonly<Record<string, ReadonlyArray<Kill>>> = {
	"line terminators": [endAnchorKill],
	anchors: [endAnchorKill],
	"empty string": [endAnchorKill],
	"non-ASCII digits": [unicodeDigitKill],
	"negated classes": [negationDroppedKill],
	"escapes and literals": [punctuationBareKill]
}

/**
 * Each family's agreement's runs, its budget measured (fastcycle's cull): its kill went red on the first case of its
 *   floor stream in every family but line terminators', on the third there, so that family runs 9, the least whose
 *   floor stream holds three cases, and every other runs 1, the least a generative search draws.
 *
 * @limitKind measured
 * @owner test/support/pg/text/differential.fixtures.ts, each family's agreement
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of one family's agreement in one run; the steered phase's cases, its cap of 10, run only while a
 *   required situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/text/differential.test.ts` at the budget
 *   before, `{ runs: 10, steered: 10 }` for every family, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   these budgets run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each family's kill (familyKills) applied alone and judged on the family's witnesses: its floor stream and
 *   its steered phase, which no run seed moves
 * @result the end anchor's kill red on case 2 of line terminators' floor stream and case 0 of anchors' and empty
 *   string's; the digit, negation and punctuation kills each on case 0 of its family's
 * @decision line terminators 9, every other family 1; no headroom: a kill its witnesses stop killing fails the kill
 *   gate, which measures it again
 * @revalidate a change of a family's patterns, alphabet, space or kills, of its label (the floor stream's seed), or of
 *   the runner's floor rule
 */
const familyRuns: Readonly<Record<string, number>> = { "line terminators": 9 }

const agreementOf = (fi: number, family: Family) => {
	const written = Arr.map(family.patterns, ([source, flags], pi) => {
		const r = refine(source, flags, loc(family.name, pi))
		if (r === "bound") {
			throw new Error(`${family.name} /${source}/${flags} exceeds the limits`)
		}
		return { source, flags, r, ecma: jsMatcher(source, flags) }
	})
	const familySketch: Gen<FamilySketch> = (source) => ({
		strings: source.draw(
			array(stringsOver(element(family.alphabet), 8), { min: 1, max: stringsPerCase })
		),
		handwritten: Arr.map(written, (w) => source.draw(walksFor(w.r))),
		generated: source.draw(
			array(
				(inner) => ({
					source: inner.draw(patternOver(family.alphabet)),
					flags: inner.draw(flagsGen),
					tapes: inner.draw(walkTapes)
				}),
				{ min: 0, max: generatedPerFamily }
			)
		)
	})
	/** A sketch's case: each generated pattern refined once, its tapes walked over its NFA where it is walked. */
	const familyCase = (sketch: FamilySketch): FamilyCase => ({
		strings: sketch.strings,
		patterns: [
			...Arr.map(written, (w, pi) => ({
				...w,
				handwritten: true,
				walks: defined(sketch.handwritten[pi], `the walks of handwritten pattern ${pi}`)
			})),
			...Arr.map(sketch.generated, (g, gi) => {
				const r = refine(g.source, g.flags, loc(family.name, written.length + gi))
				return {
					source: g.source,
					flags: g.flags,
					handwritten: false,
					r,
					walks: walksOf(r, g.tapes),
					ecma: jsMatcher(g.source, g.flags)
				}
			})
		]
	})
	return property.explore(familySketch, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [
			"domain enforced",
			"generated pattern admitted",
			"own member accepted",
			"member refused"
		] satisfies ReadonlyArray<Reached<DifferentialFeature>>,
		check:
			({ tx }, k: Case<DifferentialFeature>) =>
			(sketch) =>
				Effect.gen(function* () {
					const { session: db, schema: allocate } = yield* tx
					const schema = yield* allocate("differential")
					yield* db.query(`CREATE SCHEMA ${quoteIdent(schema)}`, [])
					const c = familyCase(sketch)
					return yield* agreeOn(db, schema, fi, family, c.patterns, c.strings, (f) => k.note(f))
				}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's RegExp membership, against the host NFA, PostgreSQL's ~ and the installed domain"
		},
		budget: { runs: familyRuns[family.name] ?? 1, steered: 10 },
		kept: [],
		kills: familyKills[family.name] ?? []
	})
}

/**
 * The nested-quantifier search's runs: its floor stream, a quarter of them, 400. It was 4,800 under Vitest: the search
 * reached its one required situation within its first cases and found "none new in its last 4,792 cases"
 * (TEST_SEED=604930236) and "none new in its last 4,780 cases" (TEST_SEED=1); at-limit's sixteen cases at each limit's
 * edge kill 11 of the 13 mutants this search kills (CATCH), and the rest are this search's kills, the two its witnesses
 * do not reach pinned by kept cases (the property's kept), which run first on every seed whatever the budget. Measured
 * on a private cluster family at TEST_SEED=1: the whole file 175.8 s of CPU and 509.7 s of PostgreSQL's at 4,800 runs
 * (lane PERF).
 */
export const nestedRuns = 1_600

/**
 * What a nested-quantifier case reaches: a pattern the compile space admits and that is large enough to stress
 * PostgreSQL's compiler, or one it refuses as past PostgreSQL's limits.
 */
export type NestedFeature = "a large pattern" | "a pattern past PostgreSQL's limits"

/** Each family's agreement, by the family's name. */
export const agreements = Rec.fromEntries(
	Arr.map(families, (family, fi) => [family.name, agreementOf(fi, family)] as const)
)
