/** What the properties of login-ambient.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted,
	type Steered
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Anchor, KeyedList } from "#compiler/live/index.ts"
import { roleDefaultSettings } from "#compiler/physical/ddl/roles.ts"
import { Money, pg } from "#compiler/public/fields.ts"
import { contained, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { printRoleSetting } from "#compiler/sql/print.ts"
import {
	ambientDefaults,
	type AmbientFeature,
	type AmbientSession,
	ambientSessionGen,
	type AmbientSetting,
	ambientSettingValues
} from "#test/support/ambient.ts"
import { Id, type IdValue, toId } from "#test/support/ids.ts"
import { pickGen } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Note = str.regex("^.{0,40}$", "su")

export const TextRelation = relation("Text", { id: Id, note: Note }, ["id"])

export const UuidRelation = relation("Uuid", { id: Id, text: Id }, ["id"])

export const MoneyRelation = relation(
	"Money",
	{
		id: Id,
		amount: pg.money,
		ratio: pg.real,
		exact: pg["double precision"],
		flag: pg.boolean
	},
	["id"]
)

export const Shadowed = schema(
	"Shadowed",
	[TextRelation, UuidRelation, MoneyRelation],
	[
		contained(on(UuidRelation, "text"), on(TextRelation, "id")),
		mutable(MoneyRelation),
		unit("Record", { id: Id })
	]
)

/** The ids a case's facts take. */
const ids = [
	toId("00000000-0000-4000-8000-000000000001"),
	toId("00000000-0000-4000-8000-000000000002"),
	toId("00000000-0000-4000-8000-000000000003"),
	toId("00000000-0000-4000-8000-000000000004")
] as const

type Id = (typeof ids)[number]

/** The link into no text a case may add, and the text it names, which no case stores. */
export const danglingLink: IdValue = toId("00000000-0000-4000-8000-0000000000fe")

export const absentText: IdValue = toId("00000000-0000-4000-8000-0000000000ff")

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
export interface Program {
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

/** One of the login's pins: a fixed default its role stores and its sessions send again at startup. */
type PinnedSetting = (typeof roleDefaultSettings)[number]

/** Whether every pin of the login stands, or which one is reset before Db.open. */
type Pin = "standing" | PinnedSetting

interface LoginCase {
	readonly ambient: AmbientSession
	readonly pin: Pin
	readonly program: Program
}

type SettingFeature = `${AmbientSetting["parameter"]} ${AmbientSetting["value"]}`

export type Feature =
	| AmbientFeature
	| SettingFeature
	| "every pin standing"
	| `the ${PinnedSetting["parameter"]} pin reset`
	| "a write refused by a law"
	| "a later page"

export const settingFeature = (s: AmbientSetting): SettingFeature => `${s.parameter} ${s.value}`

export const pinFeature = (pin: Pin): Feature =>
	pin === "standing" ? "every pin standing" : `the ${pin.parameter} pin reset`

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
			[1, element(roleDefaultSettings)]
		])
	),
	program: source.draw(programGen)
})

/**
 * A case as the generator draws it, aimed at what no witness reached yet (Steered): each setting value no witness has
 * run under takes its parameter's place in half the case's draws of it, and each pin no witness has reset is the case's
 * pin in half the case's draws of it; a rotating case is drawn unaimed.
 */
export const aimedCaseGen: Steered<LoginCase, Feature>["under"] = (steering) => (source) => {
	const c = source.draw(caseGen)
	return Option.match(steering, {
		onNone: () => c,
		onSome: (pending) => ({
			...c,
			pin: Arr.reduce(roleDefaultSettings, c.pin, (pin, p): Pin =>
				pending.has(pinFeature(p)) && source.draw(boolean) ? p : pin
			),
			ambient: {
				...c.ambient,
				settings: Arr.reduce(
					Arr.flatten(ambientSettingValues),
					c.ambient.settings,
					(settings, s): ReadonlyArray<AmbientSetting> =>
						pending.has(settingFeature(s)) && source.draw(boolean)
							? [...Arr.filter(settings, (x) => x.parameter !== s.parameter), s]
							: settings
				)
			}
		})
	})
}

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"grizzle-first path",
	"every pin standing",
	...Arr.map(roleDefaultSettings, pinFeature),
	"a write refused by a law",
	"a later page",
	...Arr.map(Arr.flatten(ambientSettingValues), settingFeature)
]

/**
 * The rows of every window `windowAt` reads from `anchor` on, in order, each window after the last key of the one
 * before, until an empty window, the end of the rows.
 */
export const walk = <Row extends object, E>(
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
export const sameId = (a: { readonly id: string }, b: { readonly id: string }): boolean =>
	a.id === b.id

/** `facts` with one fact per id, the first. */
export const byId = <F extends { readonly id: string }>(
	facts: ReadonlyArray<F>
): ReadonlyArray<F> => Arr.dedupeWith(facts, sameId)

export const amountFacts = (facts: ReadonlyArray<AmountFact>) =>
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
export const databaseAmbient = (
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

/** The login `role`'s pin `pin` reset for the scope, and stored again when the scope closes. */
export const pinReset = (role: string, pin: PinnedSetting) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const at = `ALTER ROLE ${quoteIdent(role)}`
		yield* Effect.acquireRelease(s.admin.query(`${at} RESET ${pin.parameter}`, []), () =>
			Effect.orDie(s.admin.query(`${at} SET ${printRoleSetting(pin)}`, []))
		)
	})
