/**
 * What contains.test.ts reads: pairs of a haystack and a needle drawn over ASCII letters of both cases, LIKE's three
 * special characters and characters of two, three and four UTF-8 bytes, the SQL Text.contains lowers to in a query and
 * in a check, and a staff search installed with its term a query parameter, as metis's ADM-USR-2 reads its staff.
 */
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import type { Case, Resources } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { natural } from "#compiler/public/fields.ts"
import { query, v as variable } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { asciiFolded } from "#test/pg/text/lower-ascii.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import { codeInfix } from "#test/support/oracle/evaluate/catalog.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import type { SubstrateCase, TemplateNeed } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	testPg
} from "#test/support/unit/compute/support.ts"
import { computeDesc, variable as leaf } from "#test/support/unit/compute/text.fixtures.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** LIKE's three special characters: its two wildcards and its default escape. */
const likeSpecials = [0x25, 0x5f, 0x5c] as const

/**
 * A character of a drawn text: ASCII's a and b of both cases, most often; LIKE's `%`, `_` and `\`; é (two bytes) and
 * ĩ, which share é's continuation byte, € (three bytes) and ¬, which shares €'s last byte, and 😀 and 😁 (four bytes),
 * which share a UTF-16 high surrogate; and any other character of one byte but NUL, or of more.
 */
const character: Gen<number> = weighted([
	[4, element([0x61, 0x62, 0x41, 0x42])],
	[3, element(likeSpecials)],
	[2, element([0xe9, 0x129, 0x20ac, 0xac, 0x1f600, 0x1f601])],
	[1, int(0x01, 0x7f)],
	[1, oneOf([int(0x80, 0xd7ff), int(0xe000, 0x10ffff)])]
])

/** A short text of drawn characters, the empty one among them. */
const shortText: Gen<string> = (source) =>
	codePointsText(source.draw(array(character, { min: 0, max: 10 })))

/** A text of LIKE's special characters and a or b, at least one character. */
const specialText: Gen<string> = (source) =>
	codePointsText(
		source.draw(
			array(
				weighted([
					[3, element(likeSpecials)],
					[1, element([0x61, 0x62])]
				]),
				{ min: 1, max: 3 }
			)
		)
	)

/** The characters of `text` from `start` to `end`, by code points. */
const slice = (text: string, start: number, end: number): string =>
	codePointsText(codePoints(text).slice(start, end))

/**
 * A needle for `haystack`: a run of its characters (the empty one among them), the empty text, the haystack with a
 * character more, a text of LIKE's special characters, or a text drawn apart.
 */
const needleOf =
	(haystack: string): Gen<string> =>
	(source) => {
		const length = codePoints(haystack).length
		return source.draw(
			weighted<string>([
				[
					4,
					(s) => {
						const start = s.draw(int(0, length))
						return slice(haystack, start, s.draw(int(start, length)))
					}
				],
				[1, () => ""],
				[1, (s) => `${haystack}${codePointsText([s.draw(character)])}`],
				[2, specialText],
				[2, shortText]
			])
		)
	}

/** A haystack and a needle. */
export interface Pair {
	readonly haystack: string
	readonly needle: string
}

const pair: Gen<Pair> = (source) => {
	const haystack = source.draw(shortText)
	return { haystack, needle: source.draw(needleOf(haystack)) }
}

/** A batch of pairs one round trip reads. */
export const pairBatch: Gen<ReadonlyArray<Pair>> = array(pair, { min: 1, max: 48 })

/** What one pair reaches. */
export type PairFeature =
	| "a needle held"
	| "a needle refused"
	| "the empty needle held"
	| "a needle longer than its haystack refused"
	| "a needle of several bytes held"
	| "a needle holding % refused"
	| "a needle holding _ refused"
	| "a needle holding \\ held"

export const pairFeatures = [
	"a needle held",
	"a needle refused",
	"the empty needle held",
	"a needle longer than its haystack refused",
	"a needle of several bytes held",
	"a needle holding % refused",
	"a needle holding _ refused",
	"a needle holding \\ held"
] as const satisfies ReadonlyArray<Reached<PairFeature>>

/** What a pair reaches, PostgreSQL's verdict `held` over it. */
export const pairFeaturesOf = (p: Pair, held: boolean): ReadonlyArray<PairFeature> => {
	const needle = codePoints(p.needle)
	return [
		held ? ("a needle held" as const) : ("a needle refused" as const),
		...(needle.length === 0 ? ["the empty needle held" as const] : []),
		...(!held && needle.length > codePoints(p.haystack).length
			? ["a needle longer than its haystack refused" as const]
			: []),
		...(held && Arr.some(needle, (c) => c > 0x7f)
			? ["a needle of several bytes held" as const]
			: []),
		...(!held && Arr.contains(needle, 0x25) ? ["a needle holding % refused" as const] : []),
		...(!held && Arr.contains(needle, 0x5f) ? ["a needle holding _ refused" as const] : []),
		...(held && Arr.contains(needle, 0x5c) ? ["a needle holding \\ held" as const] : [])
	]
}

/** The haystack `v` and the needle `w`, texts whose type bounds no bytes, the leaves Text.contains reads below. */
const pairColumns: Readonly<Record<string, LeafBinding>> = {
	v: { kind: "column", type: testPg.text.scalar },
	w: { kind: "column", type: testPg.text.scalar }
}

/** Text.contains(v, w), as the builder describes it. */
const containsDesc = computeDesc("contains", leaf("v"), leaf("w"))

/** Text.contains(v, w) lowered as a predicate in a lowering of `mode`: its expression and its SQL. */
export const containsLowered = (mode: "query" | "check") => {
	const lowered = lowerWith(mode, containsDesc, pairColumns, true, baseParams)
	if (!lowered.ok) {
		return assert.fail(`contains over two texts lowers in a ${mode}: ${lowered.error.message}`)
	}
	const expr = lowered.value.root.expr
	return { expr, sql: renderSql(expr, plainRender) }
}

/** A text whose pattern bounds no length: a staff member's name, and the term a search reads. */
const anyText = str.regex("^.*$", "su")

/**
 * The staff search under `name`: Staff's members by a natural key, each a name whose type bounds no bytes; `write`
 * writes them, `search` reads the members whose name holds the term, ASCII's case folded on both sides, as metis's
 * ADM-USR-2 searches its staff, and `exact` the members whose name holds the term as it stands; each term is a query
 * parameter.
 */
const staffWorld = (name: string) => {
	const Staff = relation("Staff", { at: natural, name: anyText }, ["at"])
	const S = schema(name, [Staff], [])
	const programs = {
		write: ChangeSet.empty(S).insert(Staff, []),
		search: query(S).rule((r) => {
			const { at, name: named } = variable(Staff, "s")
			const term = r.param("term", anyText)
			return r
				.match(Staff, { at, name: named })
				.where(Logic.eq(Text.contains(Text.lowerAscii(named), Text.lowerAscii(term)), true))
				.find({ at })
		}),
		exact: query(S).rule((r) => {
			const { at, name: named } = variable(Staff, "s")
			return r
				.match(Staff, { at, name: named })
				.where(Logic.eq(Text.contains(named, r.param("term", anyText)), true))
				.find({ at })
		})
	}
	return { S, world: fullWorld(S, programs, []) }
}

/** The staff search installed once per member with its server's login, as `grizzle generate` drafts it. */
export const staffTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "textcontains",
	content: { level: "staff" },
	build: (name) => ({ schema: staffWorld(name).S, logins: [staffWorld(name).world.server] }),
	ambient: ordinarySession
})

/** A search case: the staff's names at 0, 1, ..., and the terms searched. */
export interface SearchCase {
	readonly names: ReadonlyArray<string>
	readonly terms: ReadonlyArray<string>
}

/** `text` with ASCII's small letters made capitals: a term whose case only a fold matches. */
const capitalized = (text: string): string =>
	codePointsText(Arr.map(codePoints(text), (c) => (c >= 0x61 && c <= 0x7a ? c - 0x20 : c)))

/** A term: a needle for one of the names, its small letters made capitals half the time. */
const termOf =
	(names: Arr.NonEmptyReadonlyArray<string>): Gen<string> =>
	(source) => {
		const needle = source.draw(needleOf(source.draw(element(names))))
		return source.draw(boolean) ? capitalized(needle) : needle
	}

export const searchCase: Gen<SearchCase> = (source) => {
	const names = source.draw(array(shortText, { min: 1, max: 6 }))
	const [first, ...rest] = names
	const terms = source.draw(
		array(termOf([defined(first, "a first name"), ...rest]), { min: 1, max: 4 })
	)
	return { names, terms }
}

/** What a search case reaches. */
export type SearchFeature =
	| "a member found by the term as it stands"
	| "a member found only by its folded case"
	| "a term holding % or _ found by no member"
	| "the empty term found every member"

export const searchFeatures = [
	"a member found by the term as it stands",
	"a member found only by its folded case",
	"a term holding % or _ found by no member",
	"the empty term found every member"
] as const satisfies ReadonlyArray<Reached<SearchFeature>>

/**
 * The keys of the members whose name holds `term` under `fold`, in order: the reference evaluator's search, by code
 * points (test/support/oracle/evaluate/catalog.ts codeInfix).
 */
const foundBy = (
	names: ReadonlyArray<string>,
	term: string,
	fold: (text: string) => string
): ReadonlyArray<bigint> =>
	Arr.flatMap(names, (name, at) => (codeInfix(fold(term), fold(name)) ? [BigInt(at)] : []))

/**
 * One search case on its own clone: its names written, then each term searched by both queries, the term bound as
 * the query parameter, each answer the members the reference's search finds, by code points, with ASCII's case folded
 * on both sides for `search` and none for `exact`.
 */
export const searchCaseRun =
	(resources: Resources<{ readonly staff: TemplateNeed<SubstrateCase<Generated>> }>) =>
	(k: SearchCase, c: Case<SearchFeature>) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { value: generated } = yield* resources.staff
				const { world } = staffWorld(generated.installed.declared)
				const served = servedGenerated(generated, world.server)
				const context = yield* Layer.build(served.layer)
				const db = yield* Db.open(served.login.roles.app, {}).pipe(Effect.provideContext(context))
				const written = yield* writeAnswerOf(
					db.workload.write.once({
						params: {},
						facts: { insert: { Staff: Arr.map(k.names, (name, at) => ({ at: BigInt(at), name })) } }
					})
				)
				assert.equal(written._tag, "accepted", "the staff are written")
				for (const term of k.terms) {
					const shown = Formatter.format({ names: k.names, term })
					const search = yield* rowsOf(db.workload.search.once({ params: { term }, facts: {} }))
					const exact = yield* rowsOf(db.workload.exact.once({ params: { term }, facts: {} }))
					const folded = foundBy(k.names, term, asciiFolded)
					const asWritten = foundBy(k.names, term, (text) => text)
					assert.deepEqual<ReadonlyArray<bigint>>(
						Arr.sort(
							Arr.map(search, (row) => row.at),
							Order.BigInt
						),
						folded,
						`the folded search of ${shown}`
					)
					assert.deepEqual<ReadonlyArray<bigint>>(
						Arr.sort(
							Arr.map(exact, (row) => row.at),
							Order.BigInt
						),
						asWritten,
						`the exact search of ${shown}`
					)
					if (asWritten.length > 0) {
						c.note("a member found by the term as it stands")
					}
					if (folded.length > asWritten.length) {
						c.note("a member found only by its folded case")
					}
					if (
						folded.length === 0 &&
						Arr.some(codePoints(term), (ch) => ch === 0x25 || ch === 0x5f)
					) {
						c.note("a term holding % or _ found by no member")
					}
					if (term.length === 0) {
						c.note("the empty term found every member")
					}
				}
			})
		)
