/** What the properties of variant.test.ts read: its variant, its schema, its spaces and its reference model. */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, recorded, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, type Ordering as Ord, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Type } from "#compiler/public/compute.ts"
import {
	closedId,
	domain,
	generated,
	instant,
	mintOf,
	natural,
	sha256 as digest,
	variant,
	type VariantValueOf,
	bool,
	float8,
	int4,
	int8,
	numeric
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Sha256 } from "#compiler/scalar/values/sha256.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/**
 * The tag's roster: seven arms, two of them payload-less, which only their tags tell apart. Unordered, so its codes are
 * its handles' UTF-16 order in a first installation (ir/scalar.ts handlesInOrder), which the reference model reads.
 */
const Kind = closed.unordered("Kind", ["flag", "count", "ratio", "point", "name", "absent", "none"])

/** Any text of at most 40 UTF-8 bytes, so a key holds a name as itself. */
const Name = str.bytes(40, str.regex("^.*$", "su"))

/**
 * The variant: a boolean, a bigint, a double, a point's two integers, a bounded text, and two empty arms; a point's x at
 * most its y, an arm check of the variant's own type.
 */
const Value = variant(
	"Value",
	Kind,
	{
		flag: { value: bool },
		count: { value: int8 },
		ratio: { value: float8 },
		point: { x: int4, y: int4 },
		name: { text: Name },
		absent: {},
		none: {}
	},
	{ point: (a) => a.le(a.x, a.y) }
)

/** A value of the variant: its tagged union. */
type Held = VariantValueOf<typeof Value.arms>

/**
 * One cell per id, the variant's value as a plain field, and its tag as an ordinary field PostgreSQL generates from it
 * (Value.tag), which a key, a reference and a law name like any field.
 */
const Cell = relation.generated("Cell", { id: int4, value: Value }, ["id"], (r) => ({
	kind: generated(closedId(Kind), Value.tag(r.value))
}))

/**
 * A variant over a subset of Kind, the handles its arms name: count, name and none, listed out of Kind's order and held
 * in it, every other handle of Kind no value of it. Its tag is a closed id of that subset (scalar/registry.ts
 * variantTagType), so a field generated from it is of the subset's own type, closedId(Kind, { only }), which a closed id
 * of every handle enters no column of.
 */
const Some = variant("Some", Kind, {
	none: {},
	name: { text: Name },
	count: { value: int8 }
})

/** A value of the subset's variant: its tagged union over its three arms alone. */
export type SomeHeld = VariantValueOf<typeof Some.arms>

/** One value of the subset's variant per id, its tag generated as a closed id of the subset. */
const Somes = relation.generated("Somes", { id: int4, value: Some }, ["id"], (r) => ({
	kind: generated(closedId(Kind, { only: ["none", "count", "name"] }), Some.tag(r.value))
}))

/**
 * A variant whose one arm's field is a closed id of a subset of Kind, count and name: its domain's CHECK holds the field
 * to the subset's codes (physical/ddl/variants.ts), which the roster's domain the field is cast to does not, so a direct
 * writer's mark outside the subset is refused as a stored column of the subset's is.
 */
const Picked = variant("Picked", Kind, {
	flag: { mark: closedId(Kind, { only: ["count", "name"] }) }
})

/** A relation holding Picked, so the installation holds its composite and its domain. */
const Picks = relation("Picks", { id: int4, picked: Picked }, ["id"])

/** One handle, an exact integer's arm, which two variants over integers of two precisions share. */
const Exact = closed.unordered("Exact", ["n"])

/** An exact integer of 825 digits, QTI's integer, and one of 30: one value, one image (Value.digest), whatever its precision. */
const Wide = variant("Wide", Exact, { n: { value: numeric(825, 0) } })
const Narrow = variant("Narrow", Exact, { n: { value: numeric(30, 0) } })

/** A relation holding both, so the installation holds their composites and domains. */
const Exacts = relation("Exacts", { id: int4, wide: Wide, narrow: Narrow }, ["id"])

/** A reply's arms: a score, a span, a word and its tally, and silence. */
const ReplyKind = closed.unordered("ReplyKind", ["replied", "span", "word", "silent"])

const replyScoreKey = Symbol("ReplyScore")
/** A score: finite and at least zero, every NaN and either infinity outside it, -0 within it as PostgreSQL holds it 0. */
const ReplyScore = domain<typeof replyScoreKey>()("ReplyScore", float8, (s) =>
	Logic.and([Logic.ge(s, 0), Logic.lt(s, Number.POSITIVE_INFINITY)])
)
const toReplyScore = mintOf(replyScoreKey)

/** A word of one to eight lowercase letters, a pattern's domain. */
const Word = str.regex("^[a-z]{1,8}$")

const tallyKey = Symbol("Tally")
/** A tally: an integer at least zero. */
const Tally = domain<typeof tallyKey>()("Tally", int4, (n) => Logic.ge(n, 0))
const toTally = mintOf(tallyKey)

/**
 * The variant whose fields' types hold domains of their own, a contract's and a pattern's, and whose span arm holds its
 * least at most its greatest: what the host's admission of a row judges as the variant's domain's CHECK does.
 */
const Reply = variant(
	"Reply",
	ReplyKind,
	{
		replied: { score: ReplyScore },
		span: { least: int4, greatest: int4 },
		word: { text: Word, tally: Tally },
		silent: {}
	},
	{ span: (a) => a.le(a.least, a.greatest) }
)

/** A reply's value: its tagged union. */
type ReplyValue = VariantValueOf<typeof Reply.arms>

/** One reply per id. */
export const Replies = relation("Replies", { id: int4, reply: Reply }, ["id"])

/** A bag of distinct values per owner: a key over the variant, its equality the sum's. */
const Bag = relation("Bag", { owner: int4, member: Value }, ["owner", "member"])

/**
 * A bag of values per owner and instant keyed by each value's identity image, a key generation (Value.digest) the write
 * fills on the host and PostgreSQL's CHECK proves (ir/law.ts FieldWriting keyGenerated): QTI's multiple of a snapshot,
 * its key over a value an arm's unbounded text may hold and over the instant the insert stamps, which no host row holds,
 * so the host checks no key of it and fills its image all the same.
 */
const Imaged = relation.generated(
	"Imaged",
	{ owner: int4, at: instant, value: Value },
	["owner", "at", "image"],
	(r) => ({ image: generated(digest, Value.digest(r.value)) })
)

export const Variants = schema(
	"Variants",
	[Kind, Cell, Somes, Picks, Bag, Imaged, Exact, Exacts, ReplyKind, Replies],
	[]
)

const programs = Object.freeze({
	cells: ChangeSet.empty(Variants).insert(Cell, []),
	somes: ChangeSet.empty(Variants).insert(Somes, []),
	allSomes: query(Variants).rule((r) => {
		const { id, value, kind } = v(Somes, "s")
		return r.match(Somes, { id, value, kind }).find({ id, value, kind })
	}),
	replies: ChangeSet.empty(Variants).insert(Replies, []),
	bag: ChangeSet.empty(Variants).insert(Bag, []),
	imaged: ChangeSet.empty(Variants).insert(Imaged, []),
	allImaged: query(Variants).rule((r) => {
		const { owner, image } = v(Imaged, "i")
		return r.match(Imaged, { owner, image }).find({ owner, image })
	}),
	allCells: query(Variants).rule((r) => {
		const { id, value, kind } = v(Cell, "c")
		return r.match(Cell, { id, value, kind }).find({ id, value, kind })
	}),
	/** Each cell's size, one term per arm (Value.cases). */
	sizes: query(Variants).rule((r) => {
		const { id, value } = v(Cell, "c")
		return r.match(Cell, { id, value }).find({
			id,
			size: Value.cases(value, {
				flag: (a) => Logic.cond(a.value, Num.add(Type.literal(int4, 1), 0), 0n),
				count: () => 2n,
				ratio: () => 3n,
				point: (a) => Num.add(a.x, a.y),
				name: (a) => Logic.cond(Logic.eq(a.text, ""), Num.add(Type.literal(int4, 0), 0), 5n),
				absent: () => 0n,
				none: () => 0n
			})
		})
	}),
	/** The cells whose value is a parameter's (r.eq over the variant). */
	equalTo: query(Variants).rule((r) => {
		const { id, value } = v(Cell, "c")
		return r
			.match(Cell, { id, value })
			.where(r.eq(value, r.param("value", Value)))
			.find({ id })
	}),
	/** A point made of a parameter and a literal (Value.make). */
	made: query(Variants).rule((r) =>
		r.find({ value: Value.make("point", { x: r.param("x", int4), y: 70 }) })
	),
	/** Each name cell's text, its arm's field read as a column (Value.arm): no row of a cell of another arm. */
	named: query(Variants).rule((r) => {
		const { id, value } = v(Cell, "c")
		const arm = Value.arm(value, "name")
		const { text } = v(arm, "n")
		return r.match(Cell, { id, value }).match(arm, { text }).find({ id, text })
	}),
	/**
	 * Each cell's id with its cell's name arm's text attached twice, as an Option and as an array: metis's kept feedback
	 * (packages/delivery/src/reads.ts), its snapshot's 'string' arm read at the snapshot's whole key, which it attached
	 * as an array and took the head of, the types having refused the Option. The key fixes the cell and an arm's source
	 * of a cell is one row or none (ir/rel.ts callNumberings), so the Option is admitted, its text the array's head.
	 */
	feedback: query(Variants)
		.rule((r) => {
			const { id } = v(Cell, "attempt")
			return r.match(Cell, { id }).find({ id })
		})
		.attach(
			"text",
			(attempt) =>
				query(Variants).rule((r) => {
					const { value: cell } = v(Cell, "kept")
					const arm = Value.arm(cell, "name")
					const { text } = v(arm, "keptText")
					return r.match(Cell, { id: attempt.id, value: cell }).match(arm, { text }).find({ text })
				}),
			"option"
		)
		.attach(
			"texts",
			(attempt) =>
				query(Variants).rule((r) => {
					const { value: cell } = v(Cell, "kept")
					const arm = Value.arm(cell, "name")
					const { text } = v(arm, "keptText")
					return r.match(Cell, { id: attempt.id, value: cell }).match(arm, { text }).find({ text })
				}),
			"array"
		),
	allBags: query(Variants).rule((r) => {
		const { owner, member } = v(Bag, "b")
		return r.match(Bag, { owner, member }).find({ owner, member })
	}),
	/** The cells grouped by their value: each distinct value once, with how many cells hold it. */
	groups: query(Variants).rule((r) => {
		const { id, value } = v(Cell, "c")
		return r.match(Cell, { id, value }).find({ value, n: r.count() })
	}),
	/** Each cell's identity image (Value.digest), a term of a query. */
	images: query(Variants).rule((r) => {
		const { id, value } = v(Cell, "c")
		return r.match(Cell, { id, value }).find({ id, image: Value.digest(value) })
	}),
	/** Each pair of cells of one value: a join of Cell with itself on the variant. */
	pairs: query(Variants).rule((r) => {
		const x = v(Cell, "x")
		const y = v(Cell, "y")
		return r
			.match(Cell, { id: x.id, value: x.value })
			.match(Cell, { id: y.id, value: x.value })
			.find({ a: x.id, b: y.id })
	}),
	/** The image of a wide integer made of a parameter (Wide.digest), as PostgreSQL computes it. */
	wideImage: query(Variants).rule((r) =>
		r.find({ image: Wide.digest(Wide.make("n", { value: r.param("x", numeric(825, 0)) })) })
	),
	/** The image of a narrow integer made of a parameter (Narrow.digest), as PostgreSQL computes it. */
	narrowImage: query(Variants).rule((r) =>
		r.find({ image: Narrow.digest(Narrow.make("n", { value: r.param("x", numeric(30, 0)) })) })
	),
	/**
	 * No literal: qti-pie's noWalkLiterals (packages/ledger/src/grade.ts at 3ab19845), an empty relation of two texts, a
	 * natural and a made value, whose filter has no disjunct, which the simplifier makes a closed relation of no row
	 * holding a variant column: the lowering stands it on two placeholder rows under WHERE false (lower/conservative/closed).
	 */
	noLiterals: query(Variants).rule((r) =>
		r.where(r.or([])).find({
			package: Type.literal(Name, ""),
			path: Type.literal(Name, ""),
			start: Type.literal(natural, 0n),
			value: Value.make("flag", { value: false })
		})
	),
	/** No value of Some, whose first arm in its roster's order, count, holds a bigint. */
	noSomes: query(Variants).rule((r) => r.where(r.or([])).find({ value: Some.make("none", {}) })),
	/** No value of Picked, whose one arm's field is a closed id of a subset that code 0, absent's, is outside. */
	noPicks: query(Variants).rule((r) =>
		r.where(r.or([])).find({ value: Picked.make("flag", { mark: "count" }) })
	),
	/** No value of Wide, whose one arm holds an integer of 825 digits. */
	noWides: query(Variants).rule((r) =>
		r.where(r.or([])).find({ value: Wide.make("n", { value: Type.literal(numeric(825, 0), 0n) }) })
	),
	/** No value of Reply, whose first arm, replied, holds a contract over a double, so its record holds its zero sign. */
	noReplies: query(Variants).rule((r) =>
		r.where(r.or([])).find({ value: Reply.make("silent", {}) })
	),
	/**
	 * The cells an insert of cells removed, read back: a side of a delta no statement makes, which the lowering reads as
	 * an empty closed relation lowers (lower/conservative/delta), its heading the cells' with their variant.
	 */
	insertedRemoved: ChangeSet.empty(Variants)
		.insert(Cell, [])
		.read("removed", (d) =>
			query(Variants).rule((r) => {
				const { id, value } = v(d.removed(Cell), "removed")
				return r.match(d.removed(Cell), { id, value }).find({ id, value })
			})
		),
	/** The images of a ratio made of a parameter and of its negation: one exactly where the two are one value. */
	negations: query(Variants).rule((r) => {
		const x = r.param("x", float8)
		return r.find({
			plain: Value.digest(Value.make("ratio", { value: x })),
			negated: Value.digest(Value.make("ratio", { value: Num.neg(x) }))
		})
	})
})

/** What a case of variant.test.ts notes it reached. */
export type VariantFeature =
	| "a value of the subset's arms round-trips"
	| "a handle outside the subset refused"
	| "an arm field's handle outside its subset refused"
	| "the two zeros of a double are two members"
	| "a point out of its arm's check refused"
	| "a value of no whole arm refused to a direct writer"
	| "a name attached as an Option"
	| "another arm attached as none"
	| "two cells of the two zeros grouped apart"
	| "two cells of NaN grouped as one"
	| "a NaN and its negation one image"
	| "a zero and its negation two images"

/**
 * The empty reads of a variant column (anEmptyRelationOfAVariantAnswersNoRow), each with what its relation's placeholder
 * row holds: its variant's first arm, in its roster's order, over its fields' placeholders.
 */
export const emptyReads = [
	{
		read: "noLiterals",
		feature: "the consumer's heading: two texts, a natural and a variant's boolean arm"
	},
	{ read: "noSomes", feature: "a variant over a subset of its roster, its first arm a bigint's" },
	{ read: "noPicks", feature: "an arm's closed id of a subset its placeholder code is outside" },
	{ read: "noWides", feature: "an arm's integer of 825 digits" },
	{ read: "noReplies", feature: "an arm's contract over a double, beside its zero sign" },
	{ read: "insertedRemoved", feature: "a side of a delta no statement makes" }
] as const

/** An empty read of a variant column, and what it reaches. */
export type EmptyRead = (typeof emptyReads)[number]

/** What a case of anEmptyRelationOfAVariantAnswersNoRow notes it reached. */
export type EmptyFeature = EmptyRead["feature"]

/** A case of anEmptyRelationOfAVariantAnswersNoRow: one of the empty reads. */
export const emptyReadGen: Gen<EmptyRead> = (source) => source.draw(element(emptyReads))

/** What a case of aVariantsHostAdmissionIsItsDomain notes it reached. */
export type ReplyFeature =
	| "a score below zero"
	| "a zero score of each sign"
	| "a NaN score"
	| "an infinite score"
	| "a span at its bound"
	| "a span out of order"
	| "a word outside its pattern"
	| "a tally below zero"
	| "silence"

/** A score at each side of its contract's bounds: below zero, each zero, a fraction, the largest double, NaN, ±∞. */
const scoreGen: Gen<number> = element([
	-1,
	-Number.MIN_VALUE,
	-0,
	0,
	0.5,
	Number.MAX_VALUE,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
])

/** A span's ends on each side of the arm's check: equal, one past, one short, the integer type's extremes. */
const spanGen: Gen<readonly [number, number]> = element<readonly [number, number]>([
	[0, 0],
	[1, 0],
	[0, 1],
	[2147483647, -2147483648],
	[-2147483648, 2147483647]
])

/** A word on each side of its pattern: at each length bound, past it, empty, a capital, a digit. */
const wordGen: Gen<string> = element(["a", "abcdefgh", "abcdefghi", "", "Ab", "ab1"])

/** A tally on each side of its contract: below zero, zero, one, the integer type's greatest. */
const tallyGen: Gen<number> = element([-1, 0, 1, 2147483647])

/** A reply of each arm, each field drawn at its domain's boundaries. */
const replyGen: Gen<ReplyValue> = weighted<ReplyValue>([
	[2, (s) => ({ tag: "replied", score: toReplyScore(s.draw(scoreGen)) })],
	[
		2,
		(s) => {
			const [least, greatest] = s.draw(spanGen)
			return { tag: "span", least, greatest }
		}
	],
	[2, (s) => ({ tag: "word", text: s.draw(wordGen), tally: toTally(s.draw(tallyGen)) })],
	[1, () => ({ tag: "silent" })]
])

/**
 * The replies the host-admission property keeps, each written through the served Db and refused at its field: a span
 * out of its arm's check, which the variant's own domain refuses, and a reply scored -1, which ReplyScore's domain
 * refuses as the variant's domain's CHECK casts the score to it.
 */
const keptReplies: Arr.NonEmptyReadonlyArray<ReplyValue> = [
	{ tag: "span", least: 1, greatest: 0 },
	{ tag: "replied", score: toReplyScore(-1) }
]

/** The replies the property draws (replyGen), beside the ones it keeps (keptReplies), each reached by its token. */
export const replySpace = recorded(replyGen, keptReplies)

/** Whether a text is a word: one to eight lowercase ASCII letters. */
const wordAdmits = (text: string): boolean =>
	text.length >= 1 &&
	text.length <= 8 &&
	Arr.every(Str.split(text, ""), (ch) => ch >= "a" && ch <= "z")

/** A field's value as a message reads it: -0 apart from 0. */
const fieldText = (x: number | string): string =>
	typeof x === "number" && Object.is(x, -0) ? "-0" : String(x)

/** A reply as a message reads it: its arm, then its fields. */
export const replyText = (reply: ReplyValue): string => {
	switch (reply.tag) {
		case "replied":
			return `replied(${fieldText(reply.score)})`
		case "span":
			return `span(${fieldText(reply.least)}, ${fieldText(reply.greatest)})`
		case "word":
			return `word(${reply.text}, ${fieldText(reply.tally)})`
		case "silent":
			return "silent"
	}
}

/** The boundaries a reply reaches. */
export const replyFeatures = (reply: ReplyValue): ReadonlyArray<ReplyFeature> => {
	switch (reply.tag) {
		case "replied":
			return Number.isNaN(reply.score)
				? ["a NaN score"]
				: !Number.isFinite(reply.score)
					? ["an infinite score"]
					: reply.score === 0
						? ["a zero score of each sign"]
						: reply.score < 0
							? ["a score below zero"]
							: []
		case "span":
			return reply.least === reply.greatest
				? ["a span at its bound"]
				: reply.least > reply.greatest
					? ["a span out of order"]
					: []
		case "word":
			return [
				...(wordAdmits(reply.text) ? [] : ["a word outside its pattern" as const]),
				...(reply.tally < 0 ? ["a tally below zero" as const] : [])
			]
		case "silent":
			return ["silence"]
	}
}

/** What a case of anExactIntegersImageIsItsValue notes it reached. */
export type ExactFeature =
	| "a negative integer"
	| "an integer past 2^63"
	| "an integer of 825 digits"
	| "one integer at two precisions"

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const variantsInstall = Object.freeze({ label: "variant", programs })

/** Variants installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const variantsTemplate = fixtureTemplate(import.meta, Variants, variantsInstall)

/** Texts a name is drawn of: the characters record text quotes, escapes or reads as a separator, and the empty text. */
const nameCharacters = ["a", ",", "(", ")", '"', "\\", " ", "é", "😀", "x"] as const

const nameGen: Gen<string> = (s) =>
	Arr.join(s.draw(array(element(nameCharacters), { min: 0, max: 8 })), "")

/** A double: zero of each sign, NaN, the infinities, or a drawn finite value. */
const ratioGen: Gen<number> = weighted([
	[1, () => 0],
	[1, () => -0],
	[1, () => Number.NaN],
	[1, () => Number.POSITIVE_INFINITY],
	[1, () => Number.NEGATIVE_INFINITY],
	[3, (s) => s.draw(int(-4, 4)) / 2]
])

/** A value of the variant: each arm drawn, with the values its fields branch on. */
const heldGen: Gen<Held> = weighted<Held>([
	[2, (s) => ({ tag: "flag", value: s.draw(boolean) })],
	[2, (s) => ({ tag: "count", value: BigInt(s.draw(int(-3, 3))) })],
	[2, (s) => ({ tag: "ratio", value: s.draw(ratioGen) })],
	[
		2,
		(s) => {
			const a = s.draw(int(-2, 2))
			const b = s.draw(int(-2, 2))
			return { tag: "point", x: Math.min(a, b), y: Math.max(a, b) }
		}
	],
	[2, (s) => ({ tag: "name", text: s.draw(nameGen) })],
	[1, () => ({ tag: "absent" })],
	[1, () => ({ tag: "none" })]
])

/** A drawn case: values for cells, one per id, and a bag's members, which may repeat a value. */
export interface Drawn {
	readonly cells: ReadonlyArray<Held>
	readonly bag: ReadonlyArray<Held>
	readonly ratio: number
}

export const space: Gen<Drawn> = (s) => ({
	cells: s.draw(array(heldGen, { min: 1, max: 8 })),
	bag: s.draw(array(heldGen, { min: 1, max: 8 })),
	ratio: s.draw(ratioGen)
})

/** Ratio cells the variant's identity and record equality part differently: the two zeros, and two NaNs. */
const identityPairs: Arr.NonEmptyReadonlyArray<ReadonlyArray<Held>> = [
	[],
	[
		{ tag: "ratio", value: 0 },
		{ tag: "ratio", value: -0 }
	],
	[
		{ tag: "ratio", value: Number.NaN },
		{ tag: "ratio", value: Number.NaN }
	]
]

/** A case of space, its cells joined by one of identityPairs, so the zeros and the NaNs meet in its cells. */
export const identitySpace: Gen<Drawn> = (s) => {
	const d = s.draw(space)
	return { ...d, cells: [...d.cells, ...s.draw(element(identityPairs))] }
}

/**
 * The reference model's codes of Kind's handles in a first installation: an unordered roster numbers its handles in
 * their UTF-16 order (ir/scalar.ts handlesInOrder).
 */
const codes: ReadonlyMap<string, number> = new Map(
	Arr.map(Arr.sort(Kind.handles, Order.String), (h, i) => [h, i] as const)
)

/** The flag arm's code in a first installation, which a direct writer's record names its tag by. */
export const flagCode = defined(codes.get("flag"), "flag's code")

/** A handle of Kind's code in a first installation, which a direct writer's record names its tag by. */
export const kindCode = (handle: Held["tag"]): number =>
	defined(codes.get(handle), `${handle}'s code`)

/** The attributes of Some's composite: its tag, then count's value and name's text; none holds no field. */
export const someAttributes = 3

/** The handles of Kind the mark of Picked's one arm holds, and one it does not. */
export const pickedMarks = { held: "count", outside: "absent" } as const

/**
 * A value of Value as the subset's variant holds it: the value itself where Some has its arm, count, name or none; none
 * where its handle is outside the subset, of no value of Some.
 */
export const asSome = (h: Held): Option.Option<SomeHeld> => {
	switch (h.tag) {
		case "count":
		case "name":
		case "none":
			return Option.some(h)
		case "flag":
		case "ratio":
		case "point":
		case "absent":
			return Option.none()
	}
}

/**
 * The attributes of Value's composite: its tag, then each arm's fields, a double's value and its zero sign two: flag's
 * value, count's value, ratio's value and zero sign, point's x and y, name's text.
 */
export const valueAttributes = 8

/**
 * A variant's order of two doubles, its composite's record order of the double and its zero sign: NaN after every number
 * and equal to itself, then by value, and 0 before -0, which the variant's identity holds apart.
 */
const compareDouble = (a: number, b: number): Ord.Ordering =>
	Number.isNaN(a)
		? Number.isNaN(b)
			? 0
			: 1
		: Number.isNaN(b)
			? -1
			: a < b
				? -1
				: a > b
					? 1
					: Object.is(a, b)
						? 0
						: Object.is(a, -0)
							? 1
							: -1

/** A text's code points. */
const codePoints = (text: string): ReadonlyArray<number> =>
	Arr.map(Arr.fromIterable(text), (c) => Option.getOrElse(Str.codePointAt(0)(c), () => 0))

/** A text's order under C.UTF-8: its code points'. */
const compareText = (a: string, b: string): Ord.Ordering => {
	const x = codePoints(a)
	const y = codePoints(b)
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0)
		if (d !== 0) {
			return d < 0 ? -1 : 1
		}
	}
	return x.length < y.length ? -1 : x.length > y.length ? 1 : 0
}

/** The arm fields of a value, in its arm's declared order, as the reference model compares them. */
const fieldsOf = (h: Held): ReadonlyArray<boolean | bigint | number | string> => {
	switch (h.tag) {
		case "flag":
			return [h.value]
		case "count":
			return [h.value]
		case "ratio":
			return [h.value]
		case "point":
			return [h.x, h.y]
		case "name":
			return [h.text]
		case "absent":
		case "none":
			return []
	}
}

/** One field of an arm compared as PostgreSQL's order of its type compares it. */
const compareField = (
	a: boolean | bigint | number | string,
	b: boolean | bigint | number | string
): Ord.Ordering =>
	typeof a === "number" && typeof b === "number"
		? compareDouble(a, b)
		: typeof a === "string" && typeof b === "string"
			? compareText(a, b)
			: a < b
				? -1
				: a > b
					? 1
					: 0

/** The reference model's order of two values, a key's: the tag's code, then the arm's fields in declared order. */
export const compareHeld = (a: Held, b: Held): Ord.Ordering => {
	const byTag = (codes.get(a.tag) ?? 0) - (codes.get(b.tag) ?? 0)
	if (byTag !== 0) {
		return byTag < 0 ? -1 : 1
	}
	const x = fieldsOf(a)
	const y = fieldsOf(b)
	for (let i = 0; i < x.length; i++) {
		const d = compareField(defined(x[i], "a field"), defined(y[i], "a field"))
		if (d !== 0) {
			return d
		}
	}
	return 0
}

/** The values of `values` the reference model holds apart, its equality the order's 0, each at its first. */
export const distinctMembers = (values: ReadonlyArray<Held>): ReadonlyArray<Held> =>
	Arr.dedupeWith(values, (v, w) => compareHeld(v, w) === 0)

/** A double's zero of the other sign, where `h` holds a zero: a value the variant's identity holds apart from `h`. */
export const otherZero = (h: Held): Option.Option<Held> =>
	h.tag === "ratio" && h.value === 0
		? Option.some({ tag: "ratio", value: Object.is(h.value, -0) ? 0 : -0 })
		: Option.none()

/** The reference model's size of a value, the sizes program's cases term, arm by arm. */
export const sizeOf = (h: Held): bigint => {
	switch (h.tag) {
		case "flag":
			return h.value ? 1n : 0n
		case "count":
			return 2n
		case "ratio":
			return 3n
		case "point":
			return BigInt(h.x + h.y)
		case "name":
			return h.text === "" ? 0n : 5n
		case "absent":
		case "none":
			return 0n
	}
}

/** The reference model's identity of a value, its spelling: two values have one exactly where compareHeld holds them 0. */
export const identityOf = (h: Held): string => {
	switch (h.tag) {
		case "flag":
		case "count":
			return `${h.tag} ${String(h.value)}`
		case "ratio":
			return `ratio ${Number.isNaN(h.value) ? "NaN" : Object.is(h.value, -0) ? "-0" : String(h.value)}`
		case "point":
			return `point ${h.x} ${h.y}`
		case "name":
			return `name ${h.text.length} ${h.text}`
		case "absent":
		case "none":
			return h.tag
	}
}

/** How many cells hold each identity of `values`, by identity. */
export const partitionOf = (values: ReadonlyArray<Held>): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>()
	for (const h of values) {
		const key = identityOf(h)
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	return counts
}

/** A partition's counts, in one order, so two partitions compare as bags of counts. */
export const countsOf = (partition: ReadonlyMap<string, number>): ReadonlyArray<number> =>
	Arr.sort(Arr.fromIterable(partition.values()), Order.Number)

/** The SHA-256 of `bytes`. */
const sha256 = (bytes: Uint8Array): Uint8Array => Sha256.ofBytes(bytes)

/** `value`'s `width` bytes, most significant first, two's complement. */
const bigEndian = (value: bigint, width: number): Uint8Array => {
	const view = new DataView(new ArrayBuffer(8))
	view.setBigInt64(0, BigInt.asIntN(64, value))
	return new Uint8Array(view.buffer.slice(8 - width))
}

/** A double's bits, every NaN the quiet NaN of no payload, as Java's doubleToLongBits reads them. */
const doubleBits = (x: number): bigint => {
	if (Number.isNaN(x)) {
		return 0x7ff8_0000_0000_0000n
	}
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, x)
	return view.getBigInt64(0)
}

/**
 * The reference model's identity image of a value, Value.digest's definition read off the variant's documentation
 * (scalar/variant-digest.ts): the SHA-256 of its handle's digest and its fields' fixed-width images, in hex.
 */
export const imageOf = (h: Held): string => {
	const text = (t: string): Uint8Array => sha256(new TextEncoder().encode(t))
	const fields: ReadonlyArray<Uint8Array> = (() => {
		switch (h.tag) {
			case "flag":
				return [Uint8Array.of(h.value ? 1 : 0)]
			case "count":
				return [bigEndian(h.value, 8)]
			case "ratio":
				return [bigEndian(doubleBits(h.value), 8)]
			case "point":
				return [bigEndian(BigInt(h.x), 4), bigEndian(BigInt(h.y), 4)]
			case "name":
				return [text(h.text)]
			case "absent":
			case "none":
				return []
		}
	})()
	const parts = [text(h.tag), ...fields]
	const bytes = new Uint8Array(Arr.reduce(parts, 0, (n, p) => n + p.length))
	let at = 0
	for (const p of parts) {
		bytes.set(p, at)
		at += p.length
	}
	return Sha256.toHex(Sha256.ofBytes(bytes))
}

/** An exact integer drawn where an image's encoding could slip: 0, ±1, near ±2^63 and ±2^64, and 825 digits of either sign. */
export const exactGen: Gen<bigint> = weighted<bigint>([
	[1, () => 0n],
	[1, (s) => s.draw(element([1n, -1n]))],
	[
		2,
		(s) =>
			s.draw(element([2n ** 63n, 2n ** 64n])) * s.draw(element([1n, -1n])) +
			BigInt(s.draw(int(-2, 2)))
	],
	[2, (s) => BigInt(s.draw(int(-1_000_000, 1_000_000)))],
	[
		2,
		(s) => {
			const digits = Arr.join(
				Arr.map(Arr.range(1, 825), (i) =>
					i === 1 ? String(s.draw(int(1, 9))) : String(s.draw(int(0, 9)))
				),
				""
			)
			return BigInt(digits) * s.draw(element([1n, -1n]))
		}
	]
])

/** The largest magnitude numeric(30, 0) holds: an integer below it is a value of Narrow's arm too. */
export const narrowBound = 10n ** 30n

/**
 * The reference model's image of an exact integer's value of arm n (scalar/variant-digest.ts): the SHA-256 of the arm's
 * handle's digest then the SHA-256 of the integer's decimal text, in hex.
 */
export const exactImageOf = (x: bigint): string => {
	const handle = Sha256.ofBytes(new TextEncoder().encode("n"))
	const value = Sha256.ofBytes(new TextEncoder().encode(x.toString()))
	const bytes = new Uint8Array(64)
	bytes.set(handle, 0)
	bytes.set(value, 32)
	return Sha256.toHex(Sha256.ofBytes(bytes))
}
