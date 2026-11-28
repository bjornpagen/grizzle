/** What variant-arms.test.ts reads: its two versions, its space, and each case's write, migration and reads. */

import { assert } from "@bjornpagen/testing/assert"
import { aimed, array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identity } from "#compiler/core/identity.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { variantRearranged } from "#compiler/deploy/diff/diff.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, variant, bool, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { type AnyRoster, closed, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { refused } from "#test/support/assert.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import {
	expectFreshCatalog,
	type GeneratedDraft,
	generatedDraft,
	generatedHistory,
	type Installed,
	installedOf,
	loginCredentials,
	noPlaceholders,
	type Version
} from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromSnapshot, noDeclarations } from "#test/support/migrate/kit.ts"
import { installFirst, serverOf } from "#test/support/pg/closed/codes.fixtures.ts"
import { apply, noFurther, openMigrator, refusal } from "#test/support/pg/migrate/support.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** Any text of at most 24 UTF-8 bytes. */
const Name = str.bytes(24, str.regex("^.*$", "su"))

/**
 * A variant both versions declare alike, Picked, of one arm pick holding a closed id of Color, and Picks, one per id:
 * its domain's CHECK is one text in both, so only Color's losing green judges its stored values again, through the
 * variant's domain, which casts the pick's color to Color's domain (deploy/diff/diff.ts `rejudged`).
 */
const picksOf = (Color: AnyRoster) => {
	const PickKind = closed.unordered("PickKind", ["pick"])
	const Picked = variant("Picked", PickKind, { pick: { color: closedId(Color) } })
	const Picks = relation("Picks", { id: int4, picked: Picked }, ["id"])
	return { PickKind, Picks }
}

/**
 * The first version: the tag's roster Kind of three arms, a bigint, a boolean and a color, an unordered roster, so its
 * codes are its handles' UTF-16 order, count 0, flag 1, pick 2; the roster Color the pick arm holds a closed id of;
 * Cell, one value per id; Seen, keyed by the value itself, so the variant's equality is a key's; and the login `desk`
 * of a writer of both.
 */
const firstAt = (name: string) => {
	const Color = closed.unordered("Color", ["green", "red"])
	const Kind = closed.unordered("Kind", ["count", "flag", "pick"])
	const Value = variant("Value", Kind, {
		count: { value: int8 },
		flag: { on: bool },
		pick: { color: closedId(Color) }
	})
	const Cell = relation("Cell", { id: int4, value: Value }, ["id"])
	const Seen = relation("Seen", { value: Value }, ["value"])
	const { PickKind, Picks } = picksOf(Color)
	const base = schema(name, [Color, Kind, PickKind, Cell, Seen, Picks], [])
	const writer = role(base, "writer", { Cell, Seen, Picks }, { insert: ["Cell", "Seen", "Picks"] })
	const programs = {
		cells: ChangeSet.empty(writer).insert(Cell, []),
		seen: ChangeSet.empty(writer).insert(Seen, []),
		picks: ChangeSet.empty(writer).insert(Picks, [])
	}
	const desk = login(base, "desk", [writer], { workload: [workload(writer, programs)] })
	const version: Version = { schema: base, logins: [desk] }
	return { version, desk }
}

/**
 * The second version: Kind's flag renamed bit, which keeps its code, and two arms appended, absent, of no field, and
 * name, a text, each taking the next code; Color's green removed, its code a hole, and blue appended.
 */
const secondAt = (name: string) => {
	const Color = closed.unordered("Color", ["red", "blue"])
	const Kind = closed.unordered("Kind", ["count", "bit", "pick", "absent", "name"])
	const Value = variant("Value", Kind, {
		count: { value: int8 },
		bit: { on: bool },
		pick: { color: closedId(Color) },
		absent: {},
		name: { text: Name }
	})
	const Cell = relation("Cell", { id: int4, value: Value }, ["id"])
	const Seen = relation("Seen", { value: Value }, ["value"])
	const { PickKind, Picks } = picksOf(Color)
	const base = schema(name, [Color, Kind, PickKind, Cell, Seen, Picks], [])
	const writer = role(base, "writer", { Cell, Seen, Picks }, { insert: ["Cell", "Seen", "Picks"] })
	const programs = {
		cells: ChangeSet.empty(writer).insert(Cell, []),
		seen: ChangeSet.empty(writer).insert(Seen, []),
		picks: ChangeSet.empty(writer).insert(Picks, []),
		allCells: query(writer).rule((r) => {
			const { id, value } = v(Cell, "c")
			return r.match(Cell, { id, value }).find({ id, value })
		}),
		allSeen: query(writer).rule((r) => {
			const { value } = v(Seen, "s")
			return r.match(Seen, { value }).find({ value })
		})
	}
	const desk = login(base, "desk", [writer], { workload: [workload(writer, programs)] })
	const version: Version = { schema: base, logins: [desk] }
	return { version, desk }
}

/** What the second version declares: flag renamed bit, green removed. */
const secondDeclared = {
	renames: [
		{
			from: { kind: "handle", roster: parsedName("Kind"), handle: "flag" },
			to: { kind: "handle", roster: parsedName("Kind"), handle: "bit" }
		}
	],
	drops: [{ kind: "handle", roster: parsedName("Color"), handle: "green" }]
} as const

/** A value of the first version. */
type Before =
	| { readonly tag: "count"; readonly value: bigint }
	| { readonly tag: "flag"; readonly on: boolean }
	| { readonly tag: "pick"; readonly color: "green" | "red" }

/** A value of the second version. */
type After =
	| { readonly tag: "count"; readonly value: bigint }
	| { readonly tag: "bit"; readonly on: boolean }
	| { readonly tag: "pick"; readonly color: "red" | "blue" }
	| { readonly tag: "absent" }
	| { readonly tag: "name"; readonly text: string }

const beforeGen: Gen<Before> = weighted<Before>([
	[1, (s) => ({ tag: "count", value: BigInt(s.draw(int(-2, 2))) })],
	[1, (s) => ({ tag: "flag", on: s.draw(boolean) })],
	[1, (s) => ({ tag: "pick", color: s.draw(element(["green", "red"] as const)) })]
])

/** A case: the cells and the values seen the first version stores, the colors Picks holds, and a text the second's
 * name arm holds. */
export interface ArmsCase {
	readonly cells: ReadonlyArray<Before>
	readonly seen: ReadonlyArray<Before>
	readonly picks: ReadonlyArray<"green" | "red">
	readonly text: string
}

const colorGen = element(["green", "red"] as const)

/** A text the second version's name arm holds: empty, a comma, a record's quoting characters, beyond ASCII. */
const textGen = element(["", "a,b", '"(\\)"', "é😀"] as const)

/** The cases, each storing what it draws, and aimed at the one no draw stores into at all, an empty first version. */
export const armsCases = aimed<ArmsCase, ArmsFeature>(
	(s) => ({
		cells: s.draw(array(beforeGen, { min: 0, max: 5 })),
		seen: s.draw(array(beforeGen, { min: 0, max: 4 })),
		picks: s.draw(array(colorGen, { min: 0, max: 3 })),
		text: s.draw(textGen)
	}),
	[
		[
			"arms appended over no stored value",
			(s) => ({ cells: [], seen: [], picks: [], text: s.draw(textGen) })
		],
		[
			"a removed handle only an unchanged variant's field holds refused",
			(s) => ({ cells: [], seen: [], picks: ["green"], text: s.draw(textGen) })
		]
	]
)

export type ArmsFeature =
	| "arms appended over stored values"
	| "arms appended over no stored value"
	| "a removed handle a stored value's field holds refused"
	| "a removed handle only an unchanged variant's field holds refused"

/** The reference model's spelling of a value, one per value, for comparing two unordered lists of them. */
const keyOf = (value: Before | After): string => {
	switch (value.tag) {
		case "count":
			return `count ${value.value}`
		case "flag":
		case "bit":
			return `${value.tag} ${value.on}`
		case "pick":
			return `pick ${value.color}`
		case "absent":
			return "absent"
		case "name":
			return `name ${value.text}`
	}
}

/** The values of `values` the reference model holds apart, each at its first. */
const distinct = (values: ReadonlyArray<Before>): ReadonlyArray<Before> =>
	Arr.dedupeWith(values, (x, y) => keyOf(x) === keyOf(y))

/** Spellings in one order, so two lists of values compare as bags. */
const spelled = (values: ReadonlyArray<Before | After>): ReadonlyArray<string> =>
	Arr.sort(Arr.map(values, keyOf), Order.String)

/**
 * A first version's value as the second reads it: flag under its new handle, bit. No stored value holds green once the
 * second version's migration commits, since its validation refuses one.
 */
const renamed = (b: Before): After => {
	switch (b.tag) {
		case "flag":
			return { tag: "bit", on: b.on }
		case "count":
			return b
		case "pick":
			return b.color === "green"
				? assert.fail("a value holding green outlives the migration that removes green")
				: { tag: "pick", color: b.color }
	}
}

/** Whether a stored value holds green, which the second version removes. */
const holdsGreen = (b: Before): boolean => b.tag === "pick" && b.color === "green"

/**
 * A fresh install of a two-version history's last version under the name `fresh`, the history drafted again there as
 * `grizzle generate` drafts it (install-migrate.ts generatedHistory), so its codes are the migrated history's: what
 * expectFreshCatalog compares the migrated catalog with.
 */
const freshOf =
	(
		first: (name: string) => { readonly version: Version },
		second: (name: string) => { readonly version: Version },
		declared: Declarations
	) =>
	(fresh: string) =>
		Effect.map(
			generatedHistory(
				[
					(name) => ({ ...first(name).version, declarations: noDeclarations }),
					(name) => ({ ...second(name).version, declarations: declared })
				],
				fresh,
				noPlaceholders
			),
			(history) => Arr.lastNonEmpty(history).plan
		)

/**
 * The second version drafted from the snapshot `m` reached, as `grizzle generate` drafts it (install-migrate.ts
 * generatedDraft), and applied by the real runner as `m`'s owner login, which drift-checks the result.
 */
const migrateToSecond = (m: Installed) =>
	Effect.gen(function* () {
		const second = secondAt(m.declared)
		const drafted = yield* Effect.orDie(
			generatedDraft(
				{
					schema: second.version.schema,
					logins: second.version.logins,
					declarations: secondDeclared
				},
				{
					installation: identity.schema(parsedSchemaName(m.declared)),
					previous: fromSnapshot(m.snapshot),
					step: m.folders.length
				},
				noPlaceholders
			)
		)
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		const folders = Arr.append(m.folders, drafted.folder)
		const migration = apply(migrator, { snapshot: drafted.snapshot, folders }, noFurther)
		return { second, drafted, folders, migration }
	})

/**
 * A case: installs the first version, writes its cells and its distinct seen values through a Db of the writer, then
 * migrates to the second. Where a stored value's pick holds green, the migration is refused at the validation of the
 * variant's domain, which casts its pick's color to Color's domain (23514). Otherwise it commits; its catalog is a fresh
 * install's of the second version; and a Db of the second version reads every stored value back, flag under bit, writes
 * a value of each appended arm and of blue, and holds a stored value seen again unchanged under Seen's key.
 */
export const armsCase = (k: ArmsCase, c: Case<ArmsFeature>) =>
	Effect.gen(function* () {
		const { m, first } = yield* installFirst("variant_arms", firstAt)
		const seen = distinct(k.seen)
		const served = yield* servedFixture(m, first.desk)
		yield* Effect.gen(function* () {
			const db = yield* Db.open(served.login.roles.writer, {})
			const cells = yield* writeAnswerOf(
				db.workload.cells.once({
					params: {},
					facts: { insert: { Cell: Arr.map(k.cells, (value, id) => ({ id, value })) } }
				})
			)
			assert.equal(
				cells._tag,
				k.cells.length > 0 ? "accepted" : "unchanged",
				"the cells are written"
			)
			const held = yield* writeAnswerOf(
				db.workload.seen.once({
					params: {},
					facts: { insert: { Seen: Arr.map(seen, (value) => ({ value })) } }
				})
			)
			assert.equal(
				held._tag,
				seen.length > 0 ? "accepted" : "unchanged",
				"the values seen are written"
			)
			const picked = yield* writeAnswerOf(
				db.workload.picks.once({
					params: {},
					facts: {
						insert: {
							Picks: Arr.map(k.picks, (color, id) => ({
								id,
								picked: { tag: "pick", color }
							}))
						}
					}
				})
			)
			assert.equal(
				picked._tag,
				k.picks.length > 0 ? "accepted" : "unchanged",
				"the picks are written"
			)
		}).pipe(Effect.scoped, withLayer(served.layer))
		const { second, drafted, folders, migration } = yield* migrateToSecond(m)
		const changedGreen = Arr.some([...k.cells, ...seen], holdsGreen)
		if (changedGreen || k.picks.includes("green")) {
			const refused = yield* refusal(migration)
			assert.equal(serverOf(refused).sqlstate, sqlstates.checkViolation, refused.message)
			c.note(
				changedGreen
					? "a removed handle a stored value's field holds refused"
					: "a removed handle only an unchanged variant's field holds refused"
			)
			return
		}
		yield* migration
		c.note(
			k.cells.length + seen.length > 0
				? "arms appended over stored values"
				: "arms appended over no stored value"
		)
		yield* expectFreshCatalog(
			drafted.plan.installation,
			folders,
			freshOf(firstAt, secondAt, secondDeclared)
		)
		const after = yield* installedOf({
			plan: drafted.plan,
			declared: m.declared,
			folders,
			snapshot: drafted.snapshot,
			ambientOwner: m.ambientOwner,
			files: new Map(),
			credentials: yield* loginCredentials(drafted.plan, new Map(), new Map())
		})
		const servedAfter = yield* servedFixture(after, second.desk)
		yield* Effect.gen(function* () {
			const db = yield* Db.open(servedAfter.login.roles.writer, {})
			const appended: ReadonlyArray<After> = [
				{ tag: "absent" },
				{ tag: "name", text: k.text },
				{ tag: "pick", color: "blue" }
			]
			const added = yield* writeAnswerOf(
				db.workload.cells.once({
					params: {},
					facts: {
						insert: { Cell: Arr.map(appended, (value, i) => ({ id: k.cells.length + i, value })) }
					}
				})
			)
			assert.equal(added._tag, "accepted", "a value of each appended arm is written")
			const cells = yield* rowsOf(db.workload.allCells.once({ params: {}, facts: {} }))
			assert.deepEqual(
				Arr.map(cells, (row) => `${row.id} ${keyOf(row.value)}`),
				Arr.map(
					[...Arr.map(k.cells, renamed), ...appended],
					(value, id) => `${id} ${keyOf(value)}`
				),
				"every stored cell reads back under the second version, flag as bit, beside the appended arms' values"
			)
			const again = Arr.map(Arr.take(seen, 1), renamed)
			const wrote = yield* writeAnswerOf(
				db.workload.seen.once({
					params: {},
					facts: { insert: { Seen: Arr.map([...appended, ...again], (value) => ({ value })) } }
				})
			)
			assert.equal(wrote._tag, "accepted", "the appended arms' values are seen")
			const values = yield* rowsOf(db.workload.allSeen.once({ params: {}, facts: {} }))
			assert.deepEqual(
				spelled(Arr.map(values, (row) => row.value)),
				spelled([...Arr.map(seen, renamed), ...appended]),
				"Seen's key holds each value once: a stored one seen again under the second version meets itself"
			)
		}).pipe(Effect.scoped, withLayer(servedAfter.layer))
	})

/**
 * The subset's roster, Mode: unordered, so its codes are its handles' UTF-16 order, alpha 0, beta 1, delta 2, gamma 3,
 * the order the variant's composite lays its arms' attributes in (ir/codes.ts variantLayout).
 */
const modes = ["alpha", "beta", "delta", "gamma"] as const

/** The subset's first version: Sub of alpha, an integer, and beta, of no field; Held, one value per id; and `desk`. */
const subsetFirstAt = (name: string) => {
	const Mode = closed.unordered("Mode", modes)
	const Sub = variant("Sub", Mode, { alpha: { n: int4 }, beta: {} })
	const Held = relation("Held", { id: int4, value: Sub }, ["id"])
	const base = schema(name, [Mode, Held], [])
	const writer = role(base, "writer", { Held }, { insert: ["Held"] })
	const programs = { held: ChangeSet.empty(writer).insert(Held, []) }
	const desk = login(base, "desk", [writer], { workload: [workload(writer, programs)] })
	const version: Version = { schema: base, logins: [desk] }
	return { version, desk }
}

/**
 * The subset's second version: beta, of no field, left out; delta, of no field, taken in below gamma's code; and gamma,
 * a text, taken in past every arm's code, so its attribute is appended and the composite grows in place.
 */
const subsetSecondAt = (name: string) => {
	const Mode = closed.unordered("Mode", modes)
	const Sub = variant("Sub", Mode, { alpha: { n: int4 }, delta: {}, gamma: { text: Name } })
	const Held = relation("Held", { id: int4, value: Sub }, ["id"])
	const base = schema(name, [Mode, Held], [])
	const writer = role(base, "writer", { Held }, { insert: ["Held"] })
	const programs = {
		held: ChangeSet.empty(writer).insert(Held, []),
		allHeld: query(writer).rule((r) => {
			const { id, value } = v(Held, "h")
			return r.match(Held, { id, value }).find({ id, value })
		})
	}
	const desk = login(base, "desk", [writer], { workload: [workload(writer, programs)] })
	const version: Version = { schema: base, logins: [desk] }
	return { version, desk }
}

/** A version after the second the draft refuses: beta taken in again with a field, below gamma's code. */
const subsetTakenInBelowAt = (name: string): Version => {
	const Mode = closed.unordered("Mode", modes)
	const Sub = variant("Sub", Mode, {
		alpha: { n: int4 },
		beta: { on: bool },
		delta: {},
		gamma: { text: Name }
	})
	const Held = relation("Held", { id: int4, value: Sub }, ["id"])
	const base = schema(name, [Mode, Held], [])
	const writer = role(base, "writer", { Held }, { insert: ["Held"] })
	const programs = { held: ChangeSet.empty(writer).insert(Held, []) }
	return {
		schema: base,
		logins: [login(base, "desk", [writer], { workload: [workload(writer, programs)] })]
	}
}

/** A version after the second the draft refuses: gamma, of a field, left out. */
const subsetLeftOutAt = (name: string): Version => {
	const Mode = closed.unordered("Mode", modes)
	const Sub = variant("Sub", Mode, { alpha: { n: int4 }, delta: {} })
	const Held = relation("Held", { id: int4, value: Sub }, ["id"])
	const base = schema(name, [Mode, Held], [])
	const writer = role(base, "writer", { Held }, { insert: ["Held"] })
	const programs = { held: ChangeSet.empty(writer).insert(Held, []) }
	return {
		schema: base,
		logins: [login(base, "desk", [writer], { workload: [workload(writer, programs)] })]
	}
}

/** A value of the subset's first version. */
type SubBefore = { readonly tag: "alpha"; readonly n: number } | { readonly tag: "beta" }

/** A value of the subset's second version. */
type SubAfter =
	| { readonly tag: "alpha"; readonly n: number }
	| { readonly tag: "delta" }
	| { readonly tag: "gamma"; readonly text: string }

/** A case: the values the first version stores, one per id, and a text the second's gamma arm holds. */
export interface SubsetCase {
	readonly held: ReadonlyArray<SubBefore>
	readonly text: string
}

const subBeforeGen: Gen<SubBefore> = weighted<SubBefore>([
	[3, (s) => ({ tag: "alpha", n: s.draw(int(-2, 2)) })],
	[1, () => ({ tag: "beta" })]
])

/** The cases, each storing what it draws, and aimed at the one no draw stores into at all, an empty first version. */
export const subsetCases = aimed<SubsetCase, SubsetFeature>(
	(s) => ({ held: s.draw(array(subBeforeGen, { min: 0, max: 5 })), text: s.draw(textGen) }),
	[["the subset widened over no stored value", (s) => ({ held: [], text: s.draw(textGen) })]]
)

export type SubsetFeature =
	| "the subset widened over stored values"
	| "the subset widened over no stored value"
	| "a narrowing over a stored value outside the subset refused"

/** The reference model's spelling of a value of either version. */
const subKeyOf = (value: SubBefore | SubAfter): string => {
	switch (value.tag) {
		case "alpha":
			return `alpha ${value.n}`
		case "beta":
		case "delta":
			return value.tag
		case "gamma":
			return `gamma ${value.text}`
	}
}

/** A version after the second drafted from the second's snapshot, refused as a variant's arms rearranged. */
const refusedAfterSecond = (
	at: { readonly m: Installed; readonly snapshot: GeneratedDraft["snapshot"] },
	build: (name: string) => Version,
	what: string
) =>
	Effect.gen(function* () {
		const later = build(at.m.declared)
		const drafted = yield* Effect.result(
			generatedDraft(
				{ schema: later.schema, logins: later.logins, declarations: noDeclarations },
				{
					installation: identity.schema(parsedSchemaName(at.m.declared)),
					previous: fromSnapshot(at.snapshot),
					step: at.m.folders.length + 1
				},
				noPlaceholders
			)
		)
		const error = refused(drafted, "UnsupportedOperation", `${what} is drafted`)
		assert.ok(
			error.reason._tag === "UnsupportedOperation" && error.reason.capability === variantRearranged,
			`${what} is refused as a variant's arms rearranged, naming the custom migration`
		)
	})

/**
 * A case of the subset: installs the first version, writes its values through a Db of the writer, then drafts the
 * second, and from the second's snapshot the two versions whose composite would rewrite every stored value, each refused
 * when drafted. The second applied: where a stored value is beta's, which it leaves out, the migration is refused at
 * the validation of the variant's domain (23514); otherwise it commits, its catalog a fresh install's of the second
 * version, every stored value reads back, and a value of delta and of gamma, each taken in, is written and read back.
 */
export const subsetCase = (k: SubsetCase, c: Case<SubsetFeature>) =>
	Effect.gen(function* () {
		const { m, first } = yield* installFirst("variant_subset", subsetFirstAt)
		const served = yield* servedFixture(m, first.desk)
		yield* Effect.gen(function* () {
			const db = yield* Db.open(served.login.roles.writer, {})
			const written = yield* writeAnswerOf(
				db.workload.held.once({
					params: {},
					facts: { insert: { Held: Arr.map(k.held, (value, id) => ({ id, value })) } }
				})
			)
			assert.equal(
				written._tag,
				k.held.length > 0 ? "accepted" : "unchanged",
				"the first version's values are written"
			)
		}).pipe(Effect.scoped, withLayer(served.layer))
		const second = subsetSecondAt(m.declared)
		const drafted = yield* Effect.orDie(
			generatedDraft(
				{
					schema: second.version.schema,
					logins: second.version.logins,
					declarations: noDeclarations
				},
				{
					installation: identity.schema(parsedSchemaName(m.declared)),
					previous: fromSnapshot(m.snapshot),
					step: m.folders.length
				},
				noPlaceholders
			)
		)
		yield* refusedAfterSecond(
			{ m, snapshot: drafted.snapshot },
			subsetTakenInBelowAt,
			"an arm with a field taken into the subset below an arm's code"
		)
		yield* refusedAfterSecond(
			{ m, snapshot: drafted.snapshot },
			subsetLeftOutAt,
			"an arm with a field left out of the subset"
		)
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		const folders = Arr.append(m.folders, drafted.folder)
		const migration = apply(migrator, { snapshot: drafted.snapshot, folders }, noFurther)
		if (Arr.some(k.held, (value) => value.tag === "beta")) {
			const refusedMigration = yield* refusal(migration)
			assert.equal(
				serverOf(refusedMigration).sqlstate,
				sqlstates.checkViolation,
				refusedMigration.message
			)
			c.note("a narrowing over a stored value outside the subset refused")
			return
		}
		yield* migration
		c.note(
			k.held.length > 0
				? "the subset widened over stored values"
				: "the subset widened over no stored value"
		)
		yield* expectFreshCatalog(
			drafted.plan.installation,
			folders,
			freshOf(subsetFirstAt, subsetSecondAt, noDeclarations)
		)
		const after = yield* installedOf({
			plan: drafted.plan,
			declared: m.declared,
			folders,
			snapshot: drafted.snapshot,
			ambientOwner: m.ambientOwner,
			files: new Map(),
			credentials: yield* loginCredentials(drafted.plan, new Map(), new Map())
		})
		const servedAfter = yield* servedFixture(after, second.desk)
		yield* Effect.gen(function* () {
			const db = yield* Db.open(servedAfter.login.roles.writer, {})
			const takenIn: ReadonlyArray<SubAfter> = [{ tag: "delta" }, { tag: "gamma", text: k.text }]
			const added = yield* writeAnswerOf(
				db.workload.held.once({
					params: {},
					facts: {
						insert: { Held: Arr.map(takenIn, (value, i) => ({ id: k.held.length + i, value })) }
					}
				})
			)
			assert.equal(added._tag, "accepted", "a value of each arm taken in is written")
			const values = yield* rowsOf(db.workload.allHeld.once({ params: {}, facts: {} }))
			assert.deepEqual(
				Arr.map(values, (row) => `${row.id} ${subKeyOf(row.value)}`),
				Arr.map([...k.held, ...takenIn], (value, id) => `${id} ${subKeyOf(value)}`),
				"every stored value reads back under the second version, beside the values of the arms taken in"
			)
		}).pipe(Effect.scoped, withLayer(servedAfter.layer))
	})
