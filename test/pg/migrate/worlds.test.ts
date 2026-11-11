/**
 * Worlds across migrations on PostgreSQL 19: each case draws a starting version of a schema with worlds and a history
 * of one or two later versions, each turning a drawn set of the knobs a world rests on, and migrates through its
 * generated, reviewed folders (`migrated`: each drafted under the renames its version declares, applied by the real
 * runner, which drift-checks the catalog it reaches). The oracle is PostgreSQL's catalog: each login's and role's OID,
 * the drift check, Db.open's admission and the installed-catalog checker.
 *
 * The schema: documents of organizations on a tier (a roster, whose closed ids are smallint codes), each with a word
 * count and a cap (a contract), their shares and their notes (a serial field), and a derived relation over the
 * documents' word counts. Two contexts are read: the session's subject, and a quota whose cap is the contract. `editor`
 * holds the documents and the derived relation whole, refreshes it, reads Capped (the documents at the quota's cap) and
 * writes Mine, its notes under row security; `viewer` holds the organizations, the tier and the derived relation whole.
 * Both are of one login.
 *
 * The knobs, each a change a world rests on when it turns:
 * - a read query entry's head;
 * - a written entry's policy filter, among the notes of documents the subject owns, of documents shared with it, and
 *   its own, so a filter function reads another relation or stops reading one;
 * - a context's contract, the cap's least value, raised or lowered;
 * - the login's name, declared renamed (`--rename @desk=@counter`, and back);
 * - the tier's roster grown by a handle, a new names constant and roster domain under the viewer's view of the
 *   organizations, which decodes each organization's tier through the names constant;
 * - the word count retyped from integer to bigint, a column under the derived relation, whose materialized view goes and
 *   comes back, and under the editor's view of the documents.
 * A roster only grows and the word count only widens: a shrunk roster or a narrowed column is a declared drop or a data
 * step, which is another suite's.
 *
 * Properties, for every history:
 * - each folder applies and the drift check admits the catalog it reaches: every world object reading what changed was
 *   dropped before the change and created after it, in the same transaction;
 * - Db.open admits every role at the last snapshot;
 * - the installed-catalog checker finds nothing;
 * - no migration recreates a login or a role: each keeps its OID across the versions, so a password and what other
 *   roles were granted survive, a renamed login included.
 *
 * Features: each knob's turn, the login renamed back, several knobs at once and a history of two migrations, each a
 * steered case constructs while it is pending: a start where the knob turns, and the turn.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): worlds-login-recreated (a draft ignores every declared login rename,
 * so the renamed login is a new PostgreSQL role).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element, type Gen, map, subset } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	context,
	derived,
	login,
	mutable,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { type Aim, aimedAt } from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** What a version holds, each a knob a history turns. */
interface Knobs {
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
const versionOf = (name: string, k: Knobs) => {
	const Cap = contract("Cap", pg.integer, (x) => x.ge(k.capLeast))
	const Quota = context("Quota", { cap: Cap }, { claim: "q" })
	const Tier = closed("Tier", k.tiers)
	const Org = relation("Org", { id: uuid, tier: closedId(Tier) }, ["id"])
	const Doc = relation(
		"Doc",
		{
			id: uuid,
			org: uuid,
			owner: Sub,
			words: k.words === "integer" ? pg.integer : pg.bigint,
			cap: Cap
		},
		["id"]
	)
	const Share = relation("Share", { doc: uuid, user: Sub }, ["doc", "user"])
	const Note = relation("Note", { no: pg.bigserial, doc: uuid, author: Sub }, ["no"])
	const base = schema(name, [Tier, Org, Doc, Share, Note], [mutable(Doc)])
	const Busy = derived.materialized(
		"Busy",
		query(base).rule((r) => {
			const { id, words } = v(Doc, "doc")
			return r.match(Doc, { id, words }).find({ id, words })
		})
	)
	const ext = schema.extend(base, `${name}_1`, [Busy], [])
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
		{ write: ["Mine"], refresh: ["Busy"] }
	)
	const viewer = role(ext, "viewer", { Tier, Org, Busy: ext.relations.Busy })
	return { schema: ext, editor, viewer, login: login(ext, k.login, [editor, viewer]) }
}

type Built = ReturnType<typeof versionOf>

/** A turn of one knob, by the change it makes: what a case reaches. */
type WorldsFeature =
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

const historyGen: Gen<History> = (source) => {
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

/** The history each required situation is aimed at while it is pending (Case.steering), constructed to reach it. */
const aims: ReadonlyArray<Aim<History, WorldsFeature>> = [
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
const historyFeatures = (h: History): ReadonlyArray<WorldsFeature> => {
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

/** The history a case runs: its drawn one, or, while a situation `aims` reaches is pending, the one aimed at it. */
const aimedHistory = aimedAt(aims)

/** A role's OID, as the owner reads it. */
const oidQuery = "SELECT r.oid::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text"

layer(Substrate.layer)("worlds across migrations", (it) => {
	it.effect(
		"every history of the changes a world rests on migrates with its roles kept and its catalog admitted",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/migrate/worlds",
						draw: drawn(historyGen),
						literal: Formatter.format,
						oracle: {
							kind: "postgresql",
							name: "the catalog: each login's and role's OID across the versions, the runner's drift check, Db.open's admission and the installed-catalog checker"
						},
						coverage: required<WorldsFeature>(
							[
								"a read query entry's head changes",
								"a written entry's policy filter stops reading another relation",
								"a filter function reads another relation",
								"a context's contract changes",
								"the login is renamed",
								"the login is renamed back",
								"a roster under a world view grows",
								"a column under a derived relation and a world view is retyped",
								"several knobs turn at once",
								"a history of two migrations"
							],
							{ cases: 16, sense: notesOnly }
						),
						kept: [],
						runs: 2,
						shrink: { kind: "bounded", candidates: 12 },
						concurrency: 1,
						steerEvery: 4,
						caseHang
					},
					(drawnHistory, reached) =>
						Effect.gen(function* () {
							const h = aimedHistory(drawnHistory, reached)
							reached.noteAll(historyFeatures(h))
							const versions = [h.start, ...h.later]
							const substrate = yield* Substrate
							const built: Array<Built> = []
							const version =
								(k: Knobs) =>
								(name: string): Version => {
									const b = versionOf(name, k)
									built.push(b)
									return { schema: b.schema, logins: [b.login] }
								}
							const oids: Array<ReadonlyArray<string>> = []
							const m = yield* migrated({
								label: "worlds_mig",
								schemaName: { kind: "unique" },
								first: version(h.start),
								later: Arr.map(h.later, version),
								/** The one placeholder these versions draft: the word count's conversion, from its own value. */
								apply: {
									kind: "values",
									value: () =>
										`${quoteIdent(identifierOf(identity.column(parsedName("words"))))}::bigint`
								},
								/** Each login's rename, the one name a version takes from another, declared; nothing is dropped. */
								declared: (i) => {
									const from = versions[i - 1]
									const to = defined(versions[i], "a version")
									return from !== undefined && from.login !== to.login
										? {
												renames: [
													{
														from: { kind: "login", login: parsedName(from.login) },
														to: { kind: "login", login: parsedName(to.login) }
													}
												],
												drops: []
											}
										: noDeclarations
								},
								observe: Option.some((i: number, owner: RawSession) =>
									Effect.gen(function* () {
										const b = defined(built[i], `version ${i}`)
										const found: Array<string> = []
										for (const world of [b.login, b.editor, b.viewer]) {
											const rows = yield* owner.values(oidQuery, [roleNameOf(world, {})])
											for (const row of rows) {
												found.push(String(row[0]))
											}
										}
										oids.push(found)
									})
								)
							})
							/** Each version's login and roles are the same PostgreSQL roles. */
							const first = defined(oids[0], "the first version's roles")
							assert.equal(first.length, 3, "the first version's login and roles exist")
							for (const later of oids.slice(1)) {
								assert.deepEqual(later, first, "a login and its roles keep their OIDs")
							}
							yield* m.reapply
							const last = defined(built[built.length - 1], "the last version")
							yield* withServedDb(m, last.login.roles.editor, { sub: "u_ann" }, () => Effect.void)
							yield* withServedDb(m, last.login.roles.viewer, {}, () => Effect.void)
							const read = yield* readCatalog(
								substrate.admin,
								mapNonEmpty(m.installation.names.levels, identifierOf)
							)
							assert.ok(read.kind === "present", `the migrated schema ${m.schema} is absent`)
							assert.deepEqual(
								checkInstalled(read.catalog, installedScope(m.installation, m.snapshot)),
								[]
							)
						})
				)
			)
	)
})
