/**
 * What lower-ascii.test.ts reads: texts over every byte class of UTF-8, the host's ASCII case fold beside Unicode's,
 * the SQL Text.lowerAscii lowers to in a query and in a check, and the repro of a query that folds a text whose type
 * bounds no bytes (Attr's `lexical`), installed with a rule over it.
 */
import { codePoints, codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import type { Case, Resources } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer, Option, Order, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Text, Type } from "#compiler/public/compute.ts"
import { natural } from "#compiler/public/fields.ts"
import { query, v as variable } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, rowsOf } from "#test/support/calls.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import type { SubstrateCase, TemplateNeed } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	testPg,
	v
} from "#test/unit/compute/support.ts"

/** Whether a code point is an ASCII capital, A to Z: the one character ASCII's case fold changes. */
const isCapital = (c: number): boolean => c >= 0x41 && c <= 0x5a

/** The host's ASCII case fold, code point by code point: each capital its small letter, 0x20 above it. */
export const asciiFolded = (s: string): string =>
	codePointsText(Arr.map(codePoints(s), (c) => (isCapital(c) ? c + 0x20 : c)))

/** The ASCII capitals and their small letters, position for position: translate's map of the same fold. */
export const asciiCapitals = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
export const asciiSmalls = "abcdefghijklmnopqrstuvwxyz"

/** Unicode's full case fold to lower case, as ECMAScript's toLowerCase states it: what the fold must not compute. */
const unicodeLowered = (s: string): string => Str.toLowerCase(s)

/**
 * Letters past ASCII that Unicode lowers and ASCII's fold keeps: Latin-1's capital A grave, E acute and thorn, I with
 * dot above, Y diaeresis, Greek alpha and sigma, Cyrillic A, capital sharp s, the Kelvin and Ångström signs (which
 * Unicode lowers to ASCII's k and to å), Deseret's long I and Adlam's alif, each encoded in two, three or four bytes.
 */
const unicodeCapitals: Arr.NonEmptyReadonlyArray<number> = [
	0xc0, 0xc9, 0xde, 0x130, 0x178, 0x391, 0x3a3, 0x410, 0x1e9e, 0x212a, 0x212b, 0x10400, 0x1e900
]

/**
 * A character of a drawn text, over every class of byte its UTF-8 encoding begins with, and every byte after it: ASCII
 * of one byte (its capitals and their neighbours more often than the rest), a lead byte of two (U+0080 to U+07FF, whose
 * continuation bytes take every value 0x80 to 0xBF, and whose lead bytes 0xC2 to 0xDA are a capital's bits with the high
 * bit set), of three (U+0800 to U+FFFF but the surrogates) and of four (U+10000 to U+10FFFF), and the letters Unicode
 * lowers and ASCII's fold keeps.
 */
const character: Gen<number> = weighted([
	[4, int(0x41, 0x5a)],
	[2, element([0x40, 0x5b, 0x60, 0x61, 0x7a, 0x7b])],
	[2, int(0x01, 0x7f)],
	[2, int(0x80, 0x7ff)],
	[1, oneOf([int(0x800, 0xd7ff), int(0xe000, 0xffff)])],
	[1, int(0x10000, 0x10ffff)],
	[2, element(unicodeCapitals)]
])

/** A short text of drawn characters, the empty one among them. */
const shortText: Gen<string> = map(array(character, { min: 0, max: 12 }), codePointsText)

/**
 * A long text: a short one of at least one character repeated, to tens of kilobytes, which a query folds as it folds a
 * short one, every byte at its place.
 */
const longText: Gen<string> = (source) => {
	const unit = codePointsText(source.draw(array(character, { min: 1, max: 12 })))
	return Str.repeat(source.draw(int(256, 4096)))(unit)
}

/** A batch of texts one round trip folds: short ones, with at most one long one among them. */
export const textBatch: Gen<ReadonlyArray<string>> = (source) => {
	const short = source.draw(array(shortText, { min: 1, max: 32 }))
	return source.draw(
		weighted([
			[3, () => false],
			[1, () => true]
		])
	)
		? [...short, source.draw(longText)]
		: short
}

/** A text past translateMaxBytes, which the server repeats from `unit`: one copy for every `extra` past the most it holds. */
export interface PastCase {
	readonly unit: string
	readonly extra: number
}

export const pastCase: Gen<PastCase> = (source) => ({
	unit: codePointsText(source.draw(array(character, { min: 1, max: 12 }))),
	extra: source.draw(int(1, 3))
})

/** The UTF-8 bytes of a text. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** How long a text is for the search to call it long: past what one page of a heap tuple holds, kilobytes past it. */
const longBytes = 16_384

/** What a batch of folded texts reaches. */
export type FoldFeature =
	| "an ASCII capital folded"
	| "a letter Unicode lowers kept"
	| "a character of two bytes kept"
	| "a character of three bytes kept"
	| "a character of four bytes kept"
	| "a lead byte holding a capital's bits kept"
	| "an empty text"
	| "a long text folded"

export const foldFeatures = [
	"an ASCII capital folded",
	"a letter Unicode lowers kept",
	"a character of two bytes kept",
	"a character of three bytes kept",
	"a character of four bytes kept",
	"a lead byte holding a capital's bits kept",
	"an empty text",
	"a long text folded"
] as const satisfies ReadonlyArray<Reached<FoldFeature>>

/** What one text the fold kept or changed reaches. */
export const foldFeaturesOf = (s: string): ReadonlyArray<FoldFeature> => {
	const points = codePoints(s)
	const bytes = utf8(s)
	return [
		...(Arr.some(points, isCapital) ? ["an ASCII capital folded" as const] : []),
		...(Arr.some(
			points,
			(c) => c > 0x7f && unicodeLowered(codePointsText([c])) !== codePointsText([c])
		)
			? ["a letter Unicode lowers kept" as const]
			: []),
		...(Arr.some(points, (c) => c >= 0x80 && c <= 0x7ff)
			? ["a character of two bytes kept" as const]
			: []),
		...(Arr.some(points, (c) => c >= 0x800 && c <= 0xffff)
			? ["a character of three bytes kept" as const]
			: []),
		...(Arr.some(points, (c) => c > 0xffff) ? ["a character of four bytes kept" as const] : []),
		...(Arr.some(Arr.fromIterable(bytes), (b) => b >= 0xc2 && isCapital(b & 0x7f))
			? ["a lead byte holding a capital's bits kept" as const]
			: []),
		...(s.length === 0 ? ["an empty text" as const] : []),
		...(bytes.length >= longBytes ? ["a long text folded" as const] : [])
	]
}

/** A text column `v` of text whose type bounds no bytes, the leaf the folds below read. */
const anyTextColumn: Readonly<Record<string, LeafBinding>> = {
	v: { kind: "column", type: testPg.text.scalar }
}

/** Text.lowerAscii over `v`, as the builder describes it. */
const foldDesc: ExprDesc = spelledExpr(computeCore.lowerAscii(v("v", testPg.text)).expr)

/** The SQL Text.lowerAscii(v) lowers to in a lowering of `mode`, over `v` of text whose type bounds no bytes. */
export const foldSql = (mode: "query" | "check"): string => {
	const lowered = lowerWith(mode, foldDesc, anyTextColumn, false, baseParams)
	if (!lowered.ok) {
		return assert.fail(
			`lowerAscii over text of no byte bound lowers in a ${mode}: ${lowered.error.message}`
		)
	}
	return renderSql(lowered.value.root.expr, plainRender)
}

/** A text whose pattern bounds it within the key texts' 428 bytes, and one whose pattern bounds no length. */
const anyText = str.regex("^.*$", "su")
const Key = str.bytes(428, anyText)

/**
 * The repro, under `name`: Attr's `lexical` is text whose type bounds no bytes, and Folded the facts whose tag is that
 * text folded, a query over it; the rule holds every Tag fact's `at` in Folded, so a write's tag must be its
 * attribute's text folded. `lowered` reads each attribute's fold in a query, cast into the text Attr's field declares,
 * since a query's output is of a type a stored field declares, and `folded` reads Folded.
 */
const foldWorld = (name: string) => {
	const Attr = relation("Attr", { at: natural, lexical: anyText }, ["at"])
	const Tag = relation("Tag", { at: natural, tag: Key }, ["at"])
	const S = schema(name, [Attr, Tag], [])
	const Folded = derived(
		"Folded",
		query(S).rule((r) => {
			const { at, lexical } = variable(Attr, "a")
			const { tag } = variable(Tag, "t")
			return r
				.match(Attr, { at, lexical })
				.match(Tag, { at, tag })
				.where(r.eq(Text.lowerAscii(lexical), tag))
				.find({ at })
		})
	)
	const rule = contained(on(Tag, "at"), on(Folded, "at"))
	const level = schema.extend([S], `${name}_folded`, [Folded], [rule])
	const programs = {
		write: ChangeSet.empty(level).insert(Attr, []).insert(Tag, []),
		lowered: query(level).rule((r) => {
			const { at, lexical } = variable(Attr, "a")
			return r
				.match(Attr, { at, lexical })
				.find({ at, folded: Type.cast(Text.lowerAscii(lexical), anyText) })
		}),
		folded: query(level).rule((r) => {
			const { at } = variable(Folded, "f")
			return r.match(Folded, { at }).find({ at })
		})
	}
	return { level, rule, world: fullWorld(level, programs, []) }
}

/** The repro installed once per member with its writer's login, as `grizzle generate` drafts it. */
export const foldTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "lowerascii",
	content: { level: "lowerAscii" },
	build: (name) => ({ schema: foldWorld(name).level, logins: [foldWorld(name).world.server] }),
	ambient: ordinarySession
})

/** How a drawn Tag fact's tag stands to its attribute's text. */
type TagForm = "folded" | "as written" | "Unicode's fold" | "another text" | "no attribute"

/** One `at` of a repro case: its attribute's text, and its Tag fact's tag, if it has one. */
interface FoldRow {
	readonly lexical: string
	readonly tag: Option.Option<TagForm>
}

/** A repro case: the rows at 0, 1, ..., and the text a tag of "another text" holds. */
export interface FoldCase {
	readonly rows: ReadonlyArray<FoldRow>
	readonly other: string
}

/** A tag's form, its attribute's fold twice as often as each other, so a write of several tags is accepted often. */
const tagForm: Gen<TagForm> = weighted([
	[2, constant("folded")],
	[1, constant("as written")],
	[1, constant("Unicode's fold")],
	[1, constant("another text")],
	[1, constant("no attribute")]
])

/** An attribute's text: short, or long, past every key text's bound, which only a query folds. */
const attributeText: Gen<string> = weighted([
	[5, shortText],
	[1, longText]
])

export const foldCase: Gen<FoldCase> = (source) => ({
	rows: source.draw(
		array(
			(s): FoldRow => ({
				lexical: s.draw(attributeText),
				tag: s.draw(
					weighted([
						[1, () => Option.none()],
						[4, (t) => Option.some(t.draw(tagForm))]
					])
				)
			}),
			{ min: 1, max: 5 }
		)
	),
	other: source.draw(shortText)
})

/** What a repro case reaches. */
export type ReproFeature =
	| "a long attribute folded in a query"
	| "a letter Unicode lowers kept in a query"
	| "a folded tag accepted"
	| "a tag of Unicode's fold refused"
	| "a tag with an ASCII capital refused"
	| "a tag with no attribute refused"

export const reproFeatures = [
	"a long attribute folded in a query",
	"a letter Unicode lowers kept in a query",
	"a folded tag accepted",
	"a tag of Unicode's fold refused",
	"a tag with an ASCII capital refused",
	"a tag with no attribute refused"
] as const satisfies ReadonlyArray<Reached<ReproFeature>>

/** A Tag fact as a case writes it: its `at` and its tag, by its form, within Key's bound, or none for no Tag fact. */
const tagOf = (row: FoldRow, other: string): Option.Option<string> =>
	Option.flatMap(row.tag, (form) => {
		const tag =
			form === "folded"
				? asciiFolded(row.lexical)
				: form === "as written"
					? row.lexical
					: form === "Unicode's fold"
						? unicodeLowered(row.lexical)
						: other
		return utf8(tag).length <= 428 ? Option.some(tag) : Option.none()
	})

/**
 * One repro case on its own clone: its attributes written alone, which no rule reads without a tag, and read back
 * folded by the query, every one the host's fold; then its tags written, accepted exactly where each tag is its
 * attribute's text folded by the host, and otherwise refused naming the rule; Folded, read by a query once accepted, is
 * every tagged `at`.
 */
export const reproCase =
	(resources: Resources<{ readonly fold: TemplateNeed<SubstrateCase<Generated>> }>) =>
	(k: FoldCase, c: Case<ReproFeature>) =>
		Effect.scoped(
			Effect.gen(function* () {
				const { value: generated } = yield* resources.fold
				const { rule, world } = foldWorld(generated.installed.declared)
				const served = servedGenerated(generated, world.server)
				const context = yield* Layer.build(served.layer)
				const db = yield* Db.open(served.login.roles.app, {}).pipe(Effect.provideContext(context))
				const names = namesOf(generated.installed)
				const attributes = Arr.flatMap(k.rows, (row, at) =>
					Option.isSome(row.tag) && row.tag.value === "no attribute"
						? []
						: [{ at: BigInt(at), lexical: row.lexical }]
				)
				const written = yield* writeAnswerOf(
					db.workload.write.once({ params: {}, facts: { insert: { Attr: attributes, Tag: [] } } })
				)
				assert.equal(
					written.kind,
					attributes.length === 0 ? "unchanged" : "accepted",
					"attributes alone break no rule"
				)
				const lowered = yield* rowsOf(db.workload.lowered.once({ params: {}, facts: {} }))
				assert.deepEqual(
					Arr.sort(
						Arr.map(lowered, (row) => `${row.at}:${row.folded}`),
						Order.String
					),
					Arr.sort(
						Arr.map(attributes, (a) => `${a.at}:${asciiFolded(a.lexical)}`),
						Order.String
					),
					"a query folds each attribute's text as the host does"
				)
				for (const a of attributes) {
					if (utf8(a.lexical).length >= longBytes) {
						c.note("a long attribute folded in a query")
					}
					if (
						asciiFolded(a.lexical) !== unicodeLowered(a.lexical) &&
						asciiFolded(a.lexical) !== a.lexical
					) {
						c.note("a letter Unicode lowers kept in a query")
					}
				}
				const tags = Arr.flatMap(k.rows, (row, at) =>
					Option.match(tagOf(row, k.other), {
						onNone: () => [],
						onSome: (tag) => [{ at: BigInt(at), tag, row }]
					})
				)
				const attributeAt = new Map(Arr.map(attributes, (a) => [a.at, a.lexical] as const))
				const breaking = Arr.filter(tags, (t) => {
					const lexical = attributeAt.get(t.at)
					return lexical === undefined || asciiFolded(lexical) !== t.tag
				})
				const tagged = yield* writeAnswerOf(
					db.workload.write.once({
						params: {},
						facts: { insert: { Attr: [], Tag: Arr.map(tags, ({ at, tag }) => ({ at, tag })) } }
					})
				)
				const shown = Formatter.format({
					attributes,
					tags: Arr.map(tags, ({ at, tag }) => ({ at, tag }))
				})
				if (breaking.length === 0) {
					assert.equal(
						tagged.kind,
						tags.length === 0 ? "unchanged" : "accepted",
						`${shown} is accepted`
					)
					const folded = yield* rowsOf(db.workload.folded.once({ params: {}, facts: {} }))
					assert.deepEqual(
						Arr.sort(
							Arr.map(folded, (row) => row.at),
							Order.BigInt
						),
						Arr.sort(
							Arr.map(tags, (t) => t.at),
							Order.BigInt
						),
						"Folded holds every tagged at"
					)
					if (tags.length > 0) {
						c.note("a folded tag accepted")
					}
					return
				}
				assert.ok(tagged.kind === "refused", `${shown} is refused`)
				assert.deepEqual(
					refusedLaws(tagged.refused),
					[names.described(names.lawOf(rule))],
					`${shown} is refused naming the rule`
				)
				for (const t of breaking) {
					const lexical = attributeAt.get(t.at)
					if (lexical === undefined) {
						c.note("a tag with no attribute refused")
					} else if (t.tag === unicodeLowered(lexical)) {
						c.note("a tag of Unicode's fold refused")
					} else if (t.tag === lexical) {
						c.note("a tag with an ASCII capital refused")
					}
				}
			})
		)
