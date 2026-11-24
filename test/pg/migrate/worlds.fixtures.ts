/** What the properties of worlds.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, constant, element, type Gen, map, subset } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	context,
	derived,
	login,
	mutable,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Aim } from "#test/pg/migrate/support.ts"
import { Id } from "#test/support/ids.ts"

/** What a version holds, each a knob a history turns. */
export interface Knobs {
	readonly tiers: readonly ["Free", "Pro"] | readonly ["Free", "Pro", "Team"]
	readonly words: "integer" | "bigint"
	readonly capLeast: 0 | 1
	/** Mine's filter: the notes of documents the session's subject owns, of documents shared with it, or its own. */
	readonly mine: "owned" | "shared" | "authored"
	readonly capped: "id" | "id and cap"
	readonly login: "desk" | "counter"
}

/** The filters Mine may read, in the order a draw shrinks toward. */
const mines = ["owned", "shared", "authored"] as const satisfies ReadonlyArray<Knobs["mine"]>

const Sub = str.regex("^u_[a-z]{1,8}$")

const Session = context("Session", { sub: Sub })

/** The version `k` under the declared name `name`. */
export const versionOf = (name: string, k: Knobs) => {
	const Cap = contract("Cap", pg.integer, (x) => Logic.ge(x, k.capLeast))
	const Quota = context("Quota", { cap: Cap }, { claim: "q" })
	const Tier = closed.ordered("Tier", k.tiers)
	const Org = relation("Org", { id: Id, tier: closedId(Tier) }, ["id"])
	const Doc = relation(
		"Doc",
		{
			id: Id,
			org: Id,
			owner: Sub,
			words: k.words === "integer" ? pg.integer : pg.bigint,
			cap: Cap
		},
		["id"]
	)
	const Share = relation("Share", { doc: Id, user: Sub }, ["doc", "user"])
	const Note = relation("Note", { doc: Id, no: pg.integer, author: Sub }, ["doc", "no"])
	const base = schema(
		name,
		[Tier, Org, Doc, Share, Note],
		[mutable(Doc), unit("Record", { id: Id })]
	)
	/** Each document's word count, stored: Doc, open, sits in the unit Record, so Busy sits in it too. */
	const Busy = derived.stored(
		"Busy",
		query(base).rule((r) => {
			const { id, words } = v(Doc, "doc")
			return r.match(Doc, { id, words }).find({ id, words })
		})
	)
	const ext = schema.extend([base], `${name}_1`, [Busy], [])
	const mine = () => {
		switch (k.mine) {
			case "owned":
				return query(ext).rule((r) => {
					const { no, doc, author } = v(Note, "note")
					const { owner } = v(Doc, "doc")
					return r
						.match(Note, { no, doc, author })
						.match(Doc, { id: doc, owner })
						.match(Session, { sub: owner })
						.find({ no, doc, author })
				})
			case "shared":
				return query(ext).rule((r) => {
					const { no, doc, author } = v(Note, "note")
					return r
						.match(Note, { no, doc, author })
						.match(Share, { doc, user: author })
						.match(Session, { sub: author })
						.find({ no, doc, author })
				})
			case "authored":
				return query(ext).rule((r) => {
					const { no, doc, author } = v(Note, "note")
					return r
						.match(Note, { no, doc, author })
						.match(Session, { sub: author })
						.find({ no, doc, author })
				})
		}
	}
	const capped =
		k.capped === "id"
			? query(ext).rule((r) => {
					const { id, cap } = v(Doc, "doc")
					return r.match(Doc, { id, cap }).match(Quota, { cap }).find({ id })
				})
			: query(ext).rule((r) => {
					const { id, cap } = v(Doc, "doc")
					return r.match(Doc, { id, cap }).match(Quota, { cap }).find({ id, cap })
				})
	const editor = role(
		ext,
		"editor",
		{ Doc, Busy: ext.relations.Busy, Mine: mine(), Capped: capped },
		{ insert: ["Mine"], contexts: [Session, Quota] }
	)
	const viewer = role(ext, "viewer", { Tier, Org, Busy: ext.relations.Busy })
	/** Busy alone: the one relation of its level it holds, so it holds USAGE on that level's schema of whole views alone. */
	const tally = role(ext, "tally", { Busy: ext.relations.Busy })
	return {
		schema: ext,
		editor,
		viewer,
		tally,
		login: login(ext, k.login, [editor, viewer, tally])
	}
}

export type Built = ReturnType<typeof versionOf>

/** A turn of one knob, by the change it makes: what a case reaches. */
export type WorldsFeature =
	| "a read query entry's head changes"
	| "a written entry's policy filter stops reading another relation"
	| "a filter function reads another relation"
	| "a context's contract changes"
	| "the login is renamed"
	| "the login is renamed back"
	| "a roster under a world view grows"
	| "a column under a derived relation and a world view is retyped"
	| "several knobs turn at once"
	| "a history of two migrations"

/** A knob a history turns. */
type Knob = "capped" | "mine" | "capLeast" | "login" | "tiers" | "words"

/** Each knob's turn of a version: the version after it turns. */
const turnOf: { readonly [K in Knob]: (at: Knobs) => Gen<Knobs> } = {
	capped: (at) => constant<Knobs>({ ...at, capped: at.capped === "id" ? "id and cap" : "id" }),
	mine: (at) =>
		map(
			element(
				nonEmpty(
					Arr.filter(mines, (m) => m !== at.mine),
					"another filter"
				)
			),
			(mine): Knobs => ({ ...at, mine })
		),
	capLeast: (at) => constant<Knobs>({ ...at, capLeast: at.capLeast === 0 ? 1 : 0 }),
	login: (at) => constant<Knobs>({ ...at, login: at.login === "desk" ? "counter" : "desk" }),
	tiers: (at) => constant<Knobs>({ ...at, tiers: ["Free", "Pro", "Team"] }),
	words: (at) => constant<Knobs>({ ...at, words: "bigint" })
}

/** The knobs that turn at `k`: a roster grows only from two handles, and the word count widens only from integer. */
const knobsAt = (k: Knobs): Arr.NonEmptyReadonlyArray<Knob> => [
	"capped",
	"mine",
	"capLeast",
	"login",
	...(k.tiers.length === 2 ? (["tiers"] as const) : []),
	...(k.words === "integer" ? (["words"] as const) : [])
]

/** The version after turning a drawn set of `k`'s knobs, at least `fewest` of them, each once. */
const nextGen =
	(k: Knobs, fewest: number): Gen<Knobs> =>
	(source) => {
		const knobs = knobsAt(k)
		const chosen = source.draw(subset(knobs, { min: fewest, max: knobs.length }))
		return Arr.reduce(chosen, k, (at, knob) => source.draw(turnOf[knob](at)))
	}

/** A history: a starting version, and one or two later versions, each turning knobs of the one before. */
interface History {
	readonly start: Knobs
	readonly later: Arr.NonEmptyReadonlyArray<Knobs>
}

/** How each knob of a starting version is drawn, the simplest value first. */
type KnobGens = { readonly [K in keyof Knobs]: Gen<Knobs[K]> }

/** Every value of every knob. */
const anyKnobs: KnobGens = {
	tiers: element<Knobs["tiers"]>([
		["Free", "Pro"],
		["Free", "Pro", "Team"]
	]),
	words: element<Knobs["words"]>(["integer", "bigint"]),
	capLeast: element<Knobs["capLeast"]>([0, 1]),
	mine: element(mines),
	capped: element<Knobs["capped"]>(["id", "id and cap"]),
	login: element<Knobs["login"]>(["desk", "counter"])
}

/** A starting version, each knob drawn by `gens`. */
const startOf =
	(gens: KnobGens): Gen<Knobs> =>
	(source) => ({
		tiers: source.draw(gens.tiers),
		words: source.draw(gens.words),
		capLeast: source.draw(gens.capLeast),
		mine: source.draw(gens.mine),
		capped: source.draw(gens.capped),
		login: source.draw(gens.login)
	})

export const historyGen: Gen<History> = (source) => {
	const start = source.draw(startOf(anyKnobs))
	const first = source.draw(nextGen(start, 1))
	return {
		start,
		later: source.draw(boolean) ? [first, source.draw(nextGen(first, 1))] : [first]
	}
}

/** A history of one migration from a start `start` draws, its one version what `turn` draws of the start. */
const once =
	(start: Gen<Knobs>, turn: (at: Knobs) => Gen<Knobs>): Gen<History> =>
	(source) => {
		const at = source.draw(start)
		return { start: at, later: [source.draw(turn(at))] }
	}

/** A history of two migrations from a start `start` draws, each version what `turn` draws of the one before. */
const twice =
	(start: Gen<Knobs>, turn: (at: Knobs) => Gen<Knobs>): Gen<History> =>
	(source) => {
		const at = source.draw(start)
		const first = source.draw(turn(at))
		return { start: at, later: [first, source.draw(turn(first))] }
	}

/** The filters that read another relation: a filter turned to one of them reads it. */
const reading = ["owned", "shared"] as const satisfies ReadonlyArray<Knobs["mine"]>

/** The history each required situation is aimed at while it is pending, constructed to reach it: the generator draws
 * the one a case's turn aims at (aimed) in place of its plain draw. */
export const aims: ReadonlyArray<Aim<History, WorldsFeature>> = [
	["a read query entry's head changes", once(startOf(anyKnobs), turnOf.capped)],
	[
		"a written entry's policy filter stops reading another relation",
		once(startOf({ ...anyKnobs, mine: element(reading) }), (at) =>
			constant<Knobs>({ ...at, mine: "authored" })
		)
	],
	[
		"a filter function reads another relation",
		once(startOf(anyKnobs), (at) =>
			map(
				element(
					nonEmpty(
						Arr.filter(reading, (m) => m !== at.mine),
						"a filter reading another relation"
					)
				),
				(mine): Knobs => ({ ...at, mine })
			)
		)
	],
	["a context's contract changes", once(startOf(anyKnobs), turnOf.capLeast)],
	["the login is renamed", once(startOf(anyKnobs), turnOf.login)],
	["the login is renamed back", twice(startOf(anyKnobs), turnOf.login)],
	[
		"a roster under a world view grows",
		once(startOf({ ...anyKnobs, tiers: constant<Knobs["tiers"]>(["Free", "Pro"]) }), turnOf.tiers)
	],
	[
		"a column under a derived relation and a world view is retyped",
		once(startOf({ ...anyKnobs, words: constant<Knobs["words"]>("integer") }), turnOf.words)
	],
	["several knobs turn at once", once(startOf(anyKnobs), (at) => nextGen(at, 2))],
	["a history of two migrations", twice(startOf(anyKnobs), (at) => nextGen(at, 1))]
]

/** What turning `from` into `to` changes, by feature. */
const turnedOf = (from: Knobs, to: Knobs): ReadonlyArray<WorldsFeature> => [
	...(from.capped !== to.capped ? ["a read query entry's head changes" as const] : []),
	...(from.mine !== to.mine
		? [
				to.mine === "authored"
					? ("a written entry's policy filter stops reading another relation" as const)
					: ("a filter function reads another relation" as const)
			]
		: []),
	...(from.capLeast !== to.capLeast ? ["a context's contract changes" as const] : []),
	...(from.login !== to.login ? ["the login is renamed" as const] : []),
	...(from.tiers.length !== to.tiers.length ? ["a roster under a world view grows" as const] : []),
	...(from.words !== to.words
		? ["a column under a derived relation and a world view is retyped" as const]
		: [])
]

/** What a history reaches: each migration's turns, several at once, two migrations, and a login renamed back. */
export const historyFeatures = (h: History): ReadonlyArray<WorldsFeature> => {
	const versions = [h.start, ...h.later]
	const turns = Arr.flatMap(h.later, (to, i): ReadonlyArray<WorldsFeature> => {
		const turned = turnedOf(defined(versions[i], "the version before"), to)
		return turned.length > 1 ? [...turned, "several knobs turn at once"] : turned
	})
	const [first, second] = h.later
	return [
		...turns,
		...(second === undefined ? [] : ["a history of two migrations" as const]),
		...(second !== undefined && first.login !== h.start.login && second.login === h.start.login
			? ["the login is renamed back" as const]
			: [])
	]
}

/** A role's OID, as the owner reads it. */
export const oidQuery =
	"SELECT r.oid::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text"
