/**
 * A login's every answer is the same under any database defaults: its own defaults pin what its sessions resolve names
 * and print values under, and every session of its pool sends them again as startup options, so a login whose
 * search_path pin is gone answers the same.
 *
 * The file runs in a database of its own (Substrate.isolatedLayer), because a case sets that database's own defaults
 * (ALTER DATABASE ... SET), which every session that starts in the database while they stand starts under, and resets
 * each once its run ends: no other file's session starts there. Its cases run one at a time.
 *
 * The installation names its relations as PostgreSQL names its types, `Text`, `Uuid` and `Money`, so each relation's
 * row type shadows the builtin type of its name wherever the installation's schema comes first on a path. A case draws
 * an ambient session (test/support/ambient.ts), here the database's defaults: the installation's schemas first on the
 * search path or PostgreSQL's own path, and each print setting unset or at a value of its own; whether the login's
 * search_path pin stands or is reset (ALTER ROLE ... RESET search_path); and a program of writes and reads through the
 * members of the login's full role's served workload, each write's rows its call's facts: the texts inserted twice, the second an exact repeat, links into them, perhaps one into no text,
 * which the containment refuses, amounts put twice over a mutable relation, money and both float widths among their
 * fields, then the links joined to their texts, every amount, the amounts at a money parameter and from a double one,
 * one amount by its key, and every page of the amounts ordered by the double.
 *
 * Property: with the pin standing or reset, the program's every outcome and answer under the drawn defaults is exactly
 * its outcome and answer under the database's own defaults, from the same stored state; the amounts read under the
 * defaults are the facts the puts left.
 *
 * Every setting at every value it is drawn at is a required situation, beside the installation-first path, both pins,
 * a refused write and a later page.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): environment-pgoptions.patch (a login's startup options left out, so
 * its pinned defaults are not sent).
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { Anchor, KeyedList } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Money, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { paged } from "#compiler/public/workload.ts"
import type { RoleSetting } from "#compiler/sql/ast.ts"
import { printRoleSetting, quoteIdent } from "#compiler/sql/print.ts"
import { installed } from "#test/pg/reads/support.ts"
import {
	type AmbientFeature,
	type AmbientSession,
	type AmbientSetting,
	ambientDefaults,
	ambientFeatures,
	ambientSessionGen,
	ambientSettingValues
} from "#test/support/ambient.ts"
import { assert, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { answered, oneOf, rowsOf } from "#test/support/calls.ts"
import { installedSchemas, replaceMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen, pickOf } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

const Note = str.regex("^.{0,40}$", "su")
const TextRelation = relation("Text", { id: uuid, note: Note }, ["id"])
const UuidRelation = relation("Uuid", { id: uuid, text: uuid }, ["id"])
const MoneyRelation = relation(
	"Money",
	{
		id: uuid,
		amount: pg.money,
		ratio: pg.real,
		exact: pg["double precision"],
		flag: pg.boolean
	},
	["id"]
)
const Shadowed = schema(
	"Shadowed",
	[TextRelation, UuidRelation, MoneyRelation],
	[contained(on(UuidRelation, "text"), on(TextRelation, "id")), mutable(MoneyRelation)]
)

/** The ids a case's facts take. */
const ids = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
	"00000000-0000-4000-8000-000000000003",
	"00000000-0000-4000-8000-000000000004"
] as const
type Id = (typeof ids)[number]

/** The link into no text a case may add, and the text it names, which no case stores. */
const danglingLink: Uuid = "00000000-0000-4000-8000-0000000000fe"
const absentText: Uuid = "00000000-0000-4000-8000-0000000000ff"

const notes = ["", "a", "two words", "zz"] as const
type NoteText = (typeof notes)[number]

/** Money in minor units: zero, a cent either way, amounts with thousands, and the int64 edges. */
const minorUnits = [
	0n,
	1n,
	-1n,
	123456789n,
	-987654321012n,
	9223372036854775807n,
	-9223372036854775808n
] as const

/** Doubles whose shortest text has the most digits, with the extremes of the range. */
const doubles = [
	0,
	0.1,
	1 / 3,
	0.1 + 0.2,
	123456.789,
	-2.5e-300,
	5e-324,
	1.7976931348623157e308
] as const

/** Binary32 values, each the nearest to a short decimal or an extreme of the range. */
const reals = nonEmpty(
	Arr.map([0, 0.1, 1 / 3, -1e-30, 3.4028234663852886e38, 1.5], (x) => Math.fround(x)),
	"the binary32 values"
)

interface TextFact {
	readonly id: Id
	readonly note: NoteText
}

/** A link: its id, and a pick among the case's stored texts, the one it names. */
interface LinkSketch {
	readonly id: Id
	readonly pick: number
}

interface AmountFact {
	readonly id: Id
	readonly amount: bigint
	readonly ratio: number
	readonly exact: number
	readonly flag: boolean
}

/** A program: its facts, and the parameters and page size its reads take. */
interface Program {
	readonly texts: Arr.NonEmptyReadonlyArray<TextFact>
	readonly links: ReadonlyArray<LinkSketch>
	readonly dangling: boolean
	readonly amounts: ReadonlyArray<AmountFact>
	readonly revised: ReadonlyArray<AmountFact>
	readonly at: bigint
	readonly from: number
	readonly probe: Id
	readonly pageSize: number
}

/** Whether the login's search_path pin stands, or is reset before Db.open. */
type Pin = "standing" | "reset"

interface LoginCase {
	readonly ambient: AmbientSession
	readonly pin: Pin
	readonly program: Program
}

type SettingFeature = `${AmbientSetting["parameter"]} ${AmbientSetting["value"]}`

type Feature =
	| AmbientFeature
	| SettingFeature
	| `the search_path pin ${Pin}`
	| "a write refused by a law"
	| "a later page"

const settingFeature = (s: AmbientSetting): SettingFeature => `${s.parameter} ${s.value}`

/**
 * The case a witness runs, aimed at what no witness reached yet (Case.steering): each setting value no witness has run
 * under takes its parameter's place in half the case's draws of it; a rotating or kept case runs as drawn.
 */
const aimed = (c: LoginCase, cx: Case<Feature>): LoginCase =>
	Option.match(cx.steering, {
		onNone: () => c,
		onSome: (pending) => ({
			...c,
			ambient: {
				...c.ambient,
				settings: Arr.reduce(
					Arr.flatten(ambientSettingValues),
					c.ambient.settings,
					(settings, s): ReadonlyArray<AmbientSetting> =>
						pending.has(settingFeature(s)) && cx.draw(boolean)
							? [...Arr.filter(settings, (x) => x.parameter !== s.parameter), s]
							: settings
				)
			}
		})
	})

const textGen: Gen<TextFact> = (source) => ({
	id: source.draw(element(ids)),
	note: source.draw(element(notes))
})

const linkGen: Gen<LinkSketch> = (source) => ({
	id: source.draw(element(ids)),
	pick: source.draw(pickGen)
})

const amountGen: Gen<AmountFact> = (source) => ({
	id: source.draw(element(ids)),
	amount: source.draw(element(minorUnits)),
	ratio: source.draw(element(reals)),
	exact: source.draw(element(doubles)),
	flag: source.draw(boolean)
})

const programGen: Gen<Program> = (source) => ({
	texts: source.draw(
		map(array(textGen, { min: 1, max: 4 }), (texts) => nonEmpty(texts, "a program's texts"))
	),
	links: source.draw(array(linkGen, { min: 0, max: 3 })),
	dangling: source.draw(boolean),
	amounts: source.draw(array(amountGen, { min: 1, max: 4 })),
	revised: source.draw(array(amountGen, { min: 1, max: 3 })),
	at: source.draw(element(minorUnits)),
	from: source.draw(element(doubles)),
	probe: source.draw(element(ids)),
	pageSize: source.draw(int(1, 3))
})

const caseGen: Gen<LoginCase> = (source) => ({
	ambient: source.draw(ambientSessionGen),
	pin: source.draw(
		weighted<Pin>([
			[3, constant<Pin>("standing")],
			[1, constant<Pin>("reset")]
		])
	),
	program: source.draw(programGen)
})

/**
 * The installation's schemas first, and every setting at a value a draw gives it that is neither a login's pin nor
 * PostgreSQL's default.
 */
const hostileSession: AmbientSession = {
	path: { kind: "grizzleFirst" },
	settings: [
		{ parameter: "extra_float_digits", value: "-15" },
		{ parameter: "lc_monetary", value: "en_US.UTF-8" },
		{ parameter: "TimeZone", value: "Pacific/Chatham" },
		{ parameter: "DateStyle", value: "German, DMY" },
		{ parameter: "IntervalStyle", value: "sql_standard" },
		{ parameter: "bytea_output", value: "escape" }
	]
}

/** A program that meets the containment and pages past its first page. */
const plantedProgram: Program = {
	texts: [
		{ id: ids[0], note: "two words" },
		{ id: ids[1], note: "" }
	],
	links: [
		{ id: ids[0], pick: 0 },
		{ id: ids[1], pick: pickOf(1, 2) }
	],
	dangling: true,
	amounts: [
		{
			id: ids[0],
			amount: -9223372036854775808n,
			ratio: Math.fround(0.1),
			exact: 1 / 3,
			flag: true
		},
		{ id: ids[1], amount: 123456789n, ratio: Math.fround(1 / 3), exact: 0.1 + 0.2, flag: false },
		{ id: ids[2], amount: 1n, ratio: 1.5, exact: 5e-324, flag: true }
	],
	revised: [{ id: ids[1], amount: -987654321012n, ratio: 0, exact: 123456.789, flag: true }],
	at: -987654321012n,
	from: 0.1,
	probe: ids[1],
	pageSize: 1
}

const kept: ReadonlyArray<Kept<LoginCase, Feature>> = [
	{
		note: "every hostile default with the pin standing: the program's every answer is the defaults' answer",
		sketch: { ambient: hostileSession, pin: "standing", program: plantedProgram },
		draws: "",
		reaches: ["the search_path pin standing", "a write refused by a law", "a later page"]
	},
	{
		note: "every hostile default with the search_path pin reset: the startup options pin the path, every answer is the defaults' answer",
		sketch: { ambient: hostileSession, pin: "reset", program: plantedProgram },
		draws: "",
		reaches: ["the search_path pin reset", "grizzle-first path"]
	}
]

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"grizzle-first path",
	"the search_path pin standing",
	"the search_path pin reset",
	"a write refused by a law",
	"a later page",
	...Arr.map(Arr.flatten(ambientSettingValues), settingFeature)
]

/** The one search_path a login's setting can name: the pin. */
const searchPathPin: RoleSetting = { parameter: "search_path" }

/**
 * The rows of every window `windowAt` reads from `anchor` on, in order, each window after the last key of the one
 * before, until an empty window, the end of the rows.
 */
const walk = <Row extends object, E>(
	windowAt: (anchor: Anchor) => Effect.Effect<KeyedList<Row>, E>,
	anchor: Anchor
): Effect.Effect<ReadonlyArray<ReadonlyArray<Row>>, E> =>
	Effect.flatMap(windowAt(anchor), (window) =>
		Option.match(Arr.last([...window.entries()]), {
			onNone: () => Effect.succeed([]),
			onSome: (last) =>
				Effect.map(walk(windowAt, { kind: "after", key: last.key }), (rest) => [
					[...window],
					...rest
				])
		})
	)

/** Whether two facts share their id. */
const sameId = (a: { readonly id: string }, b: { readonly id: string }): boolean => a.id === b.id

/** `facts` with one fact per id, the first. */
const byId = <F extends { readonly id: string }>(facts: ReadonlyArray<F>): ReadonlyArray<F> =>
	Arr.dedupeWith(facts, sameId)

const amountFacts = (facts: ReadonlyArray<AmountFact>) =>
	Arr.map(byId(facts), (f) => ({
		id: f.id,
		amount: Money.of(f.amount),
		ratio: f.ratio,
		exact: f.exact,
		flag: f.flag
	}))

/**
 * The ambient session `ambient` as the database's own defaults for the scope, its grizzle-first path listing
 * `schemas`: each set as the database's owner, and reset when the scope closes.
 */
const databaseAmbient = (
	database: string,
	ambient: AmbientSession,
	schemas: Arr.NonEmptyReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const at = `ALTER DATABASE ${quoteIdent(database)}`
		for (const d of ambientDefaults(ambient, schemas)) {
			yield* Effect.acquireRelease(s.admin.query(`${at} SET ${d.parameter} = ${d.value}`, []), () =>
				Effect.orDie(s.admin.query(`${at} RESET ${d.parameter}`, []))
			)
		}
	})

/** The login `role`'s search_path pin reset for the scope, and stored again when the scope closes. */
const pinReset = (role: string) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const at = `ALTER ROLE ${quoteIdent(role)}`
		yield* Effect.acquireRelease(s.admin.query(`${at} RESET search_path`, []), () =>
			Effect.orDie(s.admin.query(`${at} SET ${printRoleSetting(searchPathPin)}`, []))
		)
	})

layer(Substrate.isolatedLayer)("a login under hostile database defaults", (it) => {
	it.effect(
		"answers exactly as under the database's own defaults, with its search_path pin or without it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(
						Shadowed,
						{},
						{
							label: "login_ambient",
							extensions: [],
							programs: {
								addTexts: ChangeSet.empty(Shadowed).insert(TextRelation, []),
								addLinks: ChangeSet.empty(Shadowed).insert(UuidRelation, []),
								putAmounts: ChangeSet.empty(Shadowed).put(MoneyRelation, []),
								linkedNotes: query(Shadowed).rule((r) => {
									const link = v(UuidRelation, "link")
									const text = v(TextRelation, "text")
									return r
										.match(UuidRelation, { id: link.id, text: link.text })
										.match(TextRelation, { id: link.text, note: text.note })
										.find({ id: link.id, note: text.note })
								}),
								everyAmount: query(Shadowed).rule((r) => {
									const { id, amount, ratio, exact, flag } = v(MoneyRelation, "money")
									return r
										.match(MoneyRelation, { id, amount, ratio, exact, flag })
										.find({ id, amount, ratio, exact, flag })
								}),
								atAmount: query(Shadowed).rule((r) => {
									const { id, amount } = v(MoneyRelation, "money")
									return r
										.match(MoneyRelation, { id, amount })
										.where(r.eq(amount, r.param("at", pg.money)))
										.find({ id })
								}),
								fromExact: query(Shadowed).rule((r) => {
									const { id, exact } = v(MoneyRelation, "money")
									return r
										.match(MoneyRelation, { id, exact })
										.where(r.ge(exact, r.param("from", pg["double precision"])))
										.find({ id, exact })
								}),
								byExact: paged(
									query(Shadowed)
										.rule((r) => {
											const { id, amount, ratio, exact } = v(MoneyRelation, "money")
											return r
												.match(MoneyRelation, { id, amount, ratio, exact })
												.find({ id, amount, ratio, exact })
										})
										.orderBy(["exact", "desc"])
								),
								amount: MoneyRelation
							}
						}
					)
					const database = o.installed.database
					const schemas = installedSchemas(o.installed.installation)
					const login = o.installed.as(o.server).role
					/** The program's every outcome and answer, through a Db the login opens on a layer of its own. */
					const run = (p: Program) =>
						Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							const texts = Arr.dedupeWith(p.texts, sameId)
							const links = [
								...Arr.map(byId(p.links), (l) => ({ id: l.id, text: pickFrom(texts, l.pick).id })),
								...(p.dangling ? [{ id: danglingLink, text: absentText }] : [])
							]
							const writes = [
								yield* answered(
									db.workload.addTexts.once({ params: {}, facts: { insert: { Text: texts } } })
								),
								yield* answered(
									db.workload.addTexts.once({ params: {}, facts: { insert: { Text: texts } } })
								),
								yield* answered(
									db.workload.addLinks.once({ params: {}, facts: { insert: { Uuid: links } } })
								),
								yield* answered(
									db.workload.putAmounts.once({
										params: {},
										facts: { put: { Money: amountFacts(p.amounts) } }
									})
								),
								yield* answered(
									db.workload.putAmounts.once({
										params: {},
										facts: { put: { Money: amountFacts(p.revised) } }
									})
								)
							]
							return {
								writes,
								linked: yield* rowsOf(db.workload.linkedNotes.once({ params: {}, facts: {} })),
								amounts: yield* rowsOf(db.workload.everyAmount.once({ params: {}, facts: {} })),
								at: yield* rowsOf(
									db.workload.atAmount.once({ params: { at: Money.of(p.at) }, facts: {} })
								),
								from: yield* rowsOf(
									db.workload.fromExact.once({ params: { from: p.from }, facts: {} })
								),
								probed: yield* oneOf(
									db.workload.amount.once({ params: { id: p.probe }, facts: {} })
								),
								pages: yield* walk(
									(anchor) =>
										db.workload.byExact.once({
											params: {},
											facts: {},
											window: { anchor, size: p.pageSize }
										}),
									{ kind: "start" }
								)
							}
						}).pipe(withLayer(Layer.fresh(o.served.layer)))
					return yield* explore(
						{
							oracle: {
								kind: "universal",
								name: "the program under the drawn defaults answers as under the database's own"
							},
							suite: "pg/adapter/login-ambient",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<Feature>(situations, { cases: 64, sense: notesOnly }),
							kept,
							runs: 16,
							shrink: { kind: "bounded", candidates: 24 },
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(drawnCase, cx) =>
							Effect.gen(function* () {
								const c = aimed(drawnCase, cx)
								cx.noteAll(ambientFeatures(c.ambient))
								cx.noteAll(Arr.map(c.ambient.settings, settingFeature))
								cx.note(`the search_path pin ${c.pin}`)
								yield* replaceMigrated(o.installed, {})
								const ordinary = yield* run(c.program)
								yield* replaceMigrated(o.installed, {})
								const hostile = yield* Effect.scoped(
									Effect.gen(function* () {
										yield* databaseAmbient(database, c.ambient, schemas)
										if (c.pin === "reset") {
											yield* pinReset(login)
										}
										return yield* run(c.program)
									})
								)
								assert.deepEqual(hostile.writes, ordinary.writes)
								unorderedEqual(hostile.linked, ordinary.linked)
								unorderedEqual(hostile.amounts, ordinary.amounts)
								unorderedEqual(hostile.at, ordinary.at)
								unorderedEqual(hostile.from, ordinary.from)
								assert.deepEqual(hostile.probed, ordinary.probed)
								assert.deepEqual(hostile.pages, ordinary.pages)
								unorderedEqual(
									Arr.map(ordinary.amounts, (row) => ({
										id: row.id,
										amount: row.amount,
										ratio: row.ratio,
										exact: row.exact,
										flag: row.flag
									})),
									amountFacts([...byId(c.program.revised), ...byId(c.program.amounts)])
								)
								if (Arr.some(ordinary.writes, (w) => w.kind === "refused")) {
									cx.note("a write refused by a law")
								}
								if (ordinary.pages.length > 1) {
									cx.note("a later page")
								}
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
