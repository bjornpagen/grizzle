/** What the property of digest-seeks.test.ts reads: its fixture, its box and its model. */

import { type Gen, int, uniqueKeys, element } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Crypto } from "#compiler/public/compute.ts"
import { generated, sha256, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** A text of any length, which no B-tree entry holds. */
const Path = str.regex("^.*$", "su")

/** A text of another type than T's, which a parameter an equality with T's text compares is of. */
const Word = str.regex("^[a-z]{1,40}$")

/**
 * T(k, g, t, t2) keyed by k, two texts of no byte bound, each with its declared digest, `h = Crypto.sha256(t)` and
 * `h2 = Crypto.sha256(t2)`, and S(s, u) keyed by s, whose text `u` a joined read and a negation equate with T's.
 */
const T = relation.generated("T", { k: int4, g: int4, t: Path, t2: Path }, ["k"], (row) => ({
	h: generated(sha256, Crypto.sha256(row.t)),
	h2: generated(sha256, Crypto.sha256(row.t2))
}))

const S = relation("S", { s: int4, u: Path }, ["s"])

export const Digests = schema("DigestReads", [S, T], [])

/** A query of T that delivers its texts and never their digests. */
const Texts = query(Digests).rule((r) => {
	const { k, g, t, t2 } = v(T, "t")
	return r.match(T, { k, g, t, t2 }).find({ k, g, t, t2 })
})

/** A query of T that delivers its first text and that text's digest, as pantry's attributeValues does. */
const Pairs = query(Digests).rule((r) => {
	const { k, g, t, h } = v(T, "t")
	return r.match(T, { k, g, t, h }).find({ k, g, t, h })
})

/** A query of `Pairs` that delivers its text and not its digest, as pantry's testPartRows delivers a mode. */
const Copies = query(Digests).rule((r) => {
	const { k, g, t } = v(Pairs, "pair")
	return r.match(Pairs, { k, g, t }).find({ k, g, t })
})

/** A query of `Texts` that delivers its second text, as pantry's branchResolutionRows delivers a target. */
const Carried = query(Digests).rule((r) => {
	const { k, g, t2 } = v(Texts, "text")
	return r.match(Texts, { k, g, t2 }).find({ k, g, t2 })
})

/** The reads a case holds to the model, each under its name in the workload, beside the load of its facts. */
const programs = Object.freeze({
	load: ChangeSet.empty(Digests).insert(S, []).insert(T, []),
	literal: query(Digests).rule((r) => {
		const { k, g } = v(T, "t")
		return r.match(T, { k, g, t: "x" }).find({ k, g })
	}),
	parameter: query(Digests).rule((r) => {
		const { k, g } = v(T, "t")
		return r.match(T, { k, g, t: r.param("t", Path) }).find({ k, g })
	}),
	equality: query(Digests).rule((r) => {
		const { k, g, t2 } = v(T, "t")
		return r
			.match(T, { k, g, t2 })
			.where(r.eq(t2, r.param("t", Path)))
			.find({ k, g })
	}),
	otherType: query(Digests).rule((r) => {
		const { k, g, t } = v(T, "t")
		return r
			.match(T, { k, g, t })
			.where(r.eq(t, r.param("w", Word)))
			.find({ k, g })
	}),
	membership: query(Digests).rule((r) => {
		const { k, g, t2 } = v(T, "t")
		return r
			.match(T, { k, g, t2 })
			.where(r.in(t2, ["x", "y"]))
			.find({ k, g })
	}),
	joined: query(Digests).rule((r) => {
		const { k, g, t } = v(T, "t")
		const { u } = v(S, "s")
		return r
			.match(S, { s: r.param("s", int4), u })
			.match(T, { k, g, t })
			.where(r.eq(t, u))
			.find({ k, g })
	}),
	shared: query(Digests).rule((r) => {
		const { k, g } = v(T, "t")
		const { u } = v(S, "s")
		return r
			.match(S, { s: r.param("s", int4), u })
			.match(T, { k, g, t2: u })
			.find({ k, g })
	}),
	negatedLiteral: query(Digests).rule((r) => {
		const { s, u } = v(S, "s")
		return r
			.match(S, { s, u })
			.where(r.not(T, { g: s, t: "x" }))
			.find({ s })
	}),
	negatedParameter: query(Digests).rule((r) => {
		const { s, u } = v(S, "s")
		return r
			.match(S, { s, u })
			.where(r.not(T, { g: s, t2: r.param("t", Path) }))
			.find({ s })
	}),
	imported: query(Digests).rule((r) => {
		const { k, g } = v(Pairs, "pair")
		return r.match(Pairs, { k, g, t: r.param("t", Path) }).find({ k, g })
	}),
	carriedParameter: query(Digests).rule((r) => {
		const { k, g } = v(Texts, "text")
		return r.match(Texts, { k, g, t2: r.param("t", Path) }).find({ k, g })
	}),
	carriedLiteral: query(Digests).rule((r) => {
		const { k, g } = v(Copies, "copy")
		return r.match(Copies, { k, g, t: "x" }).find({ k, g })
	}),
	carriedJoin: query(Digests).rule((r) => {
		const { k, g } = v(Carried, "carried")
		const { u } = v(S, "s")
		return r
			.match(S, { s: r.param("s", int4), u })
			.match(Carried, { k, g, t2: u })
			.find({ k, g })
	}),
	correlatedNegation: query(Digests).rule((r) => {
		const { s, u } = v(S, "s")
		return r
			.match(S, { s, u })
			.where(r.not(T, { g: s, t: u }))
			.find({ s })
	}),
	carriedNegation: query(Digests).rule((r) => {
		const { s, u } = v(S, "s")
		return r
			.match(S, { s, u })
			.where(r.not(Texts, { g: s, t2: u }))
			.find({ s })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const digestReadsInstall = Object.freeze({ label: "digest_reads", programs })

/** Digests installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const digestReadsTemplate = fixtureTemplate(import.meta, Digests, digestReadsInstall)

/**
 * A text past a B-tree entry (2,704 bytes), and one that shares all but its last character with it, so the two differ
 * only past every byte an entry could hold.
 */
const long = `${Str.repeat(3000)("x")}a`
const longTwin = `${Str.repeat(3000)("x")}b`

/**
 * The texts a case's facts and parameters hold: the empty text, short ones, a text of a multibyte character, ones that
 * differ only in case, and the two long ones.
 */
const texts = ["", "x", "y", "X", "xy", "é", long, longTwin] as const

/** The words a parameter of another text type than T's holds: each a text of T's texts too. */
const words = ["x", "y", "xy"] as const

const textGen: Gen<string> = element(texts)

/** A row of T: its key, its group and its two texts. */
export interface TRow {
	readonly k: number
	readonly g: number
	readonly t: string
	readonly t2: string
}

/** A row of S: its key, which a negation reads as T's group, and its text. */
export interface SRow {
	readonly s: number
	readonly u: string
}

/** A case: T's and S's rows, and the parameters its reads are called with. */
export interface Sketch {
	readonly ts: ReadonlyArray<TRow>
	readonly ss: ReadonlyArray<SRow>
	readonly t: string
	readonly w: string
	readonly s: number
}

/** The groups and S's keys a case draws: few, so a negation's group meets T's rows. */
const groupGen: Gen<number> = int(-2, 2)

export const sketchGen: Gen<Sketch> = (source) => {
	const ks = source.draw(uniqueKeys(int(1, 40), { min: 0, max: 8 }))
	const ts = Arr.map(ks, (k) => ({
		k,
		g: source.draw(groupGen),
		t: source.draw(textGen),
		t2: source.draw(textGen)
	}))
	const keys = source.draw(uniqueKeys(groupGen, { min: 0, max: 5 }))
	const ss = Arr.map(keys, (s) => ({ s, u: source.draw(textGen) }))
	return {
		ts,
		ss,
		t: source.draw(textGen),
		w: source.draw(element(words)),
		s: source.draw(groupGen)
	}
}

/** The facts a case loads. */
export const factsOf = (s: Sketch) => ({ S: s.ss, T: s.ts })

/** T's rows a read delivers, as `k/g`, in order. */
const tRows = (rows: ReadonlyArray<TRow>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => `${r.k}/${r.g}`),
		Order.String
	)

/** S's keys a negation keeps, as text, in order. */
const sKeys = (rows: ReadonlyArray<SRow>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (r) => String(r.s)),
		Order.String
	)

/** S's row at the asked key, if one is. */
const asked = (s: Sketch): Option.Option<SRow> => Arr.findFirst(s.ss, (r) => r.s === s.s)

/** The rows of T whose text `of` reads is `value`. */
const where = (
	s: Sketch,
	of: (r: TRow) => string,
	value: (text: string) => boolean
): ReadonlyArray<string> => tRows(Arr.filter(s.ts, (r) => value(of(r))))

/** T's rows that hold the asked row of S's text in the text `of` reads, none where S holds no row at the key. */
const joinedTo = (s: Sketch, of: (r: TRow) => string): ReadonlyArray<string> =>
	Option.match(asked(s), {
		onNone: () => [],
		onSome: (row) => where(s, of, (text) => text === row.u)
	})

/** S's rows no row of T holds at their key as its group with `value` holding of its text `of` reads. */
const negated = (
	s: Sketch,
	of: (r: TRow) => string,
	value: (row: SRow, text: string) => boolean
): ReadonlyArray<string> =>
	sKeys(Arr.filter(s.ss, (row) => !Arr.some(s.ts, (r) => r.g === row.s && value(row, of(r)))))

/**
 * Each read's rows as the undigested model states them: the rule restated over the stored facts, a text compared with
 * a value as a text, its digest never read.
 */
export const expected = (s: Sketch) => ({
	literal: where(
		s,
		(r) => r.t,
		(x) => x === "x"
	),
	parameter: where(
		s,
		(r) => r.t,
		(x) => x === s.t
	),
	equality: where(
		s,
		(r) => r.t2,
		(x) => x === s.t
	),
	otherType: where(
		s,
		(r) => r.t,
		(x) => x === s.w
	),
	membership: where(
		s,
		(r) => r.t2,
		(x) => x === "x" || x === "y"
	),
	joined: joinedTo(s, (r) => r.t),
	shared: joinedTo(s, (r) => r.t2),
	negatedLiteral: negated(
		s,
		(r) => r.t,
		(_, x) => x === "x"
	),
	negatedParameter: negated(
		s,
		(r) => r.t2,
		(_, x) => x === s.t
	),
	imported: where(
		s,
		(r) => r.t,
		(x) => x === s.t
	),
	carriedParameter: where(
		s,
		(r) => r.t2,
		(x) => x === s.t
	),
	carriedLiteral: where(
		s,
		(r) => r.t,
		(x) => x === "x"
	),
	carriedJoin: joinedTo(s, (r) => r.t2),
	correlatedNegation: negated(
		s,
		(r) => r.t,
		(row, x) => x === row.u
	),
	carriedNegation: negated(
		s,
		(r) => r.t2,
		(row, x) => x === row.u
	)
})

export type Feature =
	| "a long text sought and found"
	| "two long texts that differ past a B-tree entry"
	| "a negation that drops a row"
	| "a negation that keeps a row"
	| "a join through queries that finds a row"

/** The features a case reaches. */
export const featuresOf = (s: Sketch): ReadonlyArray<Feature> => {
	const e = expected(s)
	const isLong = (x: string): boolean => x === long || x === longTwin
	return [
		...((isLong(s.t) && e.carriedParameter.length > 0) ||
		Option.exists(asked(s), (row) => isLong(row.u) && e.carriedJoin.length > 0)
			? ["a long text sought and found" as const]
			: []),
		...(Arr.some(s.ts, (r) => r.t === long || r.t2 === long) &&
		Arr.some(s.ts, (r) => r.t === longTwin || r.t2 === longTwin)
			? ["two long texts that differ past a B-tree entry" as const]
			: []),
		...(e.carriedNegation.length < s.ss.length || e.correlatedNegation.length < s.ss.length
			? ["a negation that drops a row" as const]
			: []),
		...(e.carriedNegation.length > 0 || e.correlatedNegation.length > 0
			? ["a negation that keeps a row" as const]
			: []),
		...(e.carriedJoin.length > 0 ? ["a join through queries that finds a row" as const] : [])
	]
}
