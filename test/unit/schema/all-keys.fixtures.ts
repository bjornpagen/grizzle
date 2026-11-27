/** What the properties of all-keys.test.ts read: its space, its model and the schemas it compiles. */

import { boolean, type FiniteSpace, finite } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { KeyFault } from "#compiler/core/causes.ts"
import { defaultOpclass } from "#compiler/ir/law.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { InstallOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { accumulated, Bits, bits, drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	closed,
	contained,
	fin,
	fold,
	key,
	Monoid,
	on,
	ordered,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { btreeMaxItemSize, typlens } from "#compiler/schema/representability.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { codebookOfStates, type RosterState } from "#test/support/closed/generate.ts"
import { Id } from "#test/support/ids.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { requesting } from "#test/unit/physical/fixtures.ts"

/**
 * The kinds of key a drawn schema holds, each judged by one check of the compile, in the order the compile meets them:
 *
 * - `declared`: a relation keyed by its text, D(t), judged by ownership (schema/own.ts ownKey);
 * - `projected`: a key over a selection of P, its text where P is live, judged by the law model (laws/model/plan.ts);
 * - `target`: A(k, t) contained in B(k, t), a superkey of B's key (k), whose UNIQUE the law model plans and judges;
 * - `fold`: Doc's text the concat fold of its Lines' pieces, its running text riding the family's axes, judged by the law
 *   model as the fold's;
 * - `set`: Order's flags the union fold of its Items' sets of a roster Tag, the axes' UNIQUE over a set its codes size,
 *   judged by the installation (physical/ddl/tables.ts setUniqueBound);
 * - `lookup`: R's text read in its order by a page seek, an index the index engine creates and judges
 *   (physical/indexes/engine.ts createIndex).
 */
export const keyKinds = ["declared", "projected", "target", "fold", "set", "lookup"] as const
export type KeyKind = (typeof keyKinds)[number]

/** The checks of the compile, in the order it meets them: ownership, the law model, the tables, the index engine. */
type Stage = 0 | 1 | 2 | 3

const stageOf: Readonly<Record<KeyKind, Stage>> = {
	declared: 0,
	projected: 1,
	target: 1,
	fold: 1,
	set: 2,
	lookup: 3
}

/** The units of each kind a schema holds: two declared keys, so two keys of one check are refused at once, and one of
 * every other kind. */
const unitsOf: Readonly<Record<KeyKind, number>> = {
	declared: 2,
	projected: 1,
	target: 1,
	fold: 1,
	set: 1,
	lookup: 1
}

/** One unit of a drawn schema: its kind, its place among the units of its kind, which names its relations, and whether
 * its key is unrepresentable. */
export interface DrawnUnit {
	readonly kind: KeyKind
	readonly at: number
	readonly unrepresentable: boolean
}

/**
 * A drawn schema: its units, and whether its installation meets a refusal of another kind, an extension schema it may
 * not create, after the law model and before its tables and indexes.
 */
export interface KeysCase {
	readonly units: ReadonlyArray<DrawnUnit>
	readonly later: boolean
}

/** The box: every unit of every kind (unitsOf), each of a key that fits or of one that does not, and a later refusal
 * or none: 2^8 cases, exhausted. */
export const keysCaseSpace: FiniteSpace<KeysCase> = finite((source) => ({
	units: Arr.flatMap(keyKinds, (kind) =>
		upTo(unitsOf[kind], (at) => ({ kind, at, unrepresentable: source.draw(boolean) }))
	),
	later: source.draw(boolean)
}))

/** The text of a unit: the wildcard, which no byte bound proves, or the wildcard bounded at a few bytes. */
const free = str.regex("^.*$", "su")
const textOf = (u: DrawnUnit) => (u.unrepresentable ? free : str.bytes(16, free))

/** A refused key as the model states it: its subject and its fault's kind. */
export interface ModelKey {
	readonly subject: string
	readonly fault: KeyFault["kind"]
	readonly stage: Stage
}

/** The refusal of a unit whose key is unrepresentable, as the compile words it. */
const refusalOf = (u: DrawnUnit): ModelKey => {
	const n = u.at
	const stage = stageOf[u.kind]
	switch (u.kind) {
		case "declared":
			return { subject: `key (t) of D${n}`, fault: "unboundedText", stage }
		case "projected":
			return { subject: `key selected P${n}(t)`, fault: "unboundedText", stage }
		case "target":
			return {
				subject: `the UNIQUE of B${n} the containment of A${n}(k, t) in B${n}(k, t) references`,
				fault: "unboundedText",
				stage
			}
		case "fold":
			return {
				subject: `the concat fold of Line${n}.piece into Doc${n}.text`,
				fault: "foldAccumulator",
				stage
			}
		case "set":
			return {
				subject: `the UNIQUE (order, at, after) of Item${n}, over a set its roster's codes size`,
				fault: "btreeEntry",
				stage
			}
		case "lookup":
			return { subject: `access index (t) of R${n}`, fault: "unboundedText", stage }
	}
}

/**
 * The model: what the compile of a case refuses. Every unit's unrepresentable key, each named once, in the order of the
 * checks that judge them; or, where a refusal of another kind stops the installation first, the keys met before it, its
 * ownership's and its law model's, in its place, and that refusal itself where none was met.
 */
export type Verdict =
	| { readonly kind: "installed" }
	| { readonly kind: "keys"; readonly keys: Arr.NonEmptyReadonlyArray<ModelKey> }
	| { readonly kind: "later" }

export const verdictOf = (c: KeysCase): Verdict => {
	const met = Arr.map(
		Arr.filter(c.units, (u) => u.unrepresentable && (!c.later || stageOf[u.kind] < 2)),
		refusalOf
	)
	if (Arr.isReadonlyArrayNonEmpty(met)) {
		return { kind: "keys", keys: met }
	}
	return c.later ? { kind: "later" } : { kind: "installed" }
}

/** What a unit adds to its schema: its relations and its statements. */
interface UnitParts {
	readonly relations: ReadonlyArray<AnyRelation | AnyClosed>
	readonly statements: ReadonlyArray<Statement>
}

/** A declared unit: D0 or D1, keyed by its text. */
const declaredParts = (u: DrawnUnit): UnitParts => {
	const t = textOf(u)
	return {
		relations: [u.at === 0 ? relation("D0", { t }, ["t"]) : relation("D1", { t }, ["t"])],
		statements: []
	}
}

/** The relations and statements of a unit, each kind's one unit named by its place, 0. */
const unitParts = (u: DrawnUnit): UnitParts => {
	const t = textOf(u)
	switch (u.kind) {
		case "declared":
			return declaredParts(u)
		case "projected": {
			const P = relation("P0", { id: Id, live: pg.boolean, t }, ["id"])
			return {
				relations: [P],
				statements: [
					key(
						on(
							select(P, (r) => r.eq(r.live, true)),
							"t"
						)
					)
				]
			}
		}
		case "target": {
			const B = relation("B0", { k: Id, t }, ["k"])
			const A = relation("A0", { id: Id, k: Id, t }, ["id"])
			return { relations: [B, A], statements: [contained(on(A, "k", "t"), on(B, "k", "t"))] }
		}
		case "fold": {
			const Doc = relation("Doc0", { id: Id, n: drawn(natural), text: accumulated(t, "") }, ["id"])
			const Line = relation(
				"Line0",
				{
					doc: Id,
					at: drawn(natural),
					piece: t,
					before: accumulated(t, ""),
					after: accumulated(t, "")
				},
				["doc", "at"]
			)
			const lines = ordered(on(Line, "doc", "at"), fin(Doc, "n"))
			return {
				relations: [Doc, Line],
				statements: [
					lines,
					fold(
						lines,
						Monoid.concat,
						on(Line, "doc", "piece", "before", "after"),
						on(Doc, "id", "text")
					)
				]
			}
		}
		case "set": {
			const Tag = closed.ordered("Tag0", ["red", "blue"])
			const none = Bits.of(Tag, [])
			const Order = relation(
				"Order0",
				{ id: Id, n: drawn(natural), seen: accumulated(bits(Tag), none) },
				["id"]
			)
			const Item = relation(
				"Item0",
				{
					order: Id,
					at: drawn(natural),
					flags: bits(Tag),
					before: accumulated(bits(Tag), none),
					after: accumulated(bits(Tag), none)
				},
				["order", "at"]
			)
			const items = ordered(on(Item, "order", "at"), fin(Order, "n"))
			return {
				relations: [Tag, Order, Item],
				statements: [
					items,
					fold(
						items,
						Monoid.or,
						on(Item, "order", "flags", "before", "after"),
						on(Order, "id", "seen")
					)
				]
			}
		}
		case "lookup":
			return { relations: [relation("R0", { id: Id, t }, ["id"])], statements: [] }
	}
}

/**
 * Item's (order, at, after) entry in any order of its columns, a uuid, a bigint and a bit(n), each datum after its worst
 * alignment padding, the bit(n) its varlena header and 4-byte bit count, then a byte per eight codes: the most codes it
 * holds within BTMaxItemSize, itself MAXALIGNed (nbtree.h, restated).
 */
const keyPrefixBytes = 8 + typlens.uuid + (typlens.int8 - 1 + typlens.int8)
const fittingCodes = 8 * (btreeMaxItemSize - (keyPrefixBytes + (4 - 1)) - (4 + typlens.int4))

/** A set unit's roster: its two live handles, and past the codes Item's entry holds where its key is unrepresentable. */
const rosterOf = (u: DrawnUnit): RosterState => ({
	closed: parsedName("Tag0"),
	slots: [
		{ kind: "live" as const, handle: "red" },
		{ kind: "live" as const, handle: "blue" },
		...upTo(u.unrepresentable ? fittingCodes : 0, (i) => ({
			kind: "hole" as const,
			was: `gone${i}`
		}))
	],
	spellings: { plain: 1 }
})

/** A lookup unit's request: R's text read in its order from the first, as a page seek reads it. */
const lookupRequest: IndexRequest = {
	relation: "R0",
	keys: [{ expr: "t", dir: "asc", opclass: defaultOpclass }],
	method: "btree",
	fixed: 0,
	role: "access",
	use: "page seek"
}

/**
 * A case's installation: its units' relations and statements in one schema, compiled under its rosters' codes with its
 * lookups requested, and an extension schema no installation may create where a later refusal is drawn.
 */
export const installCase = (c: KeysCase) => {
	const parts = Arr.map(c.units, unitParts)
	const owned = succeeded(
		ownedInput(
			schema(
				"AllKeys",
				Arr.flatMap(parts, (p) => p.relations),
				Arr.flatMap(parts, (p) => p.statements)
			)
		),
		"every case owns: ownership refuses no unrepresentable key itself"
	)
	const options: InstallOptions = completeInstallOptions(
		owned,
		installationsOf(owned),
		[],
		[
			requesting(
				Arr.map(
					Arr.filter(c.units, (u) => u.kind === "lookup"),
					() => lookupRequest
				)
			)
		],
		codebookOfStates(
			Arr.map(
				Arr.filter(c.units, (u) => u.kind === "set"),
				rosterOf
			)
		)
	)
	return compileInstallation(
		owned,
		c.later ? { ...options, extensionSchema: "Not Admitted" } : options
	)
}

export type KeysFeature =
	| "nothing unrepresentable, installed"
	| "one key refused"
	| "several keys refused at once"
	| "keys of every check refused at once"
	| "a later refusal behind keys"
	| "a later refusal alone"
	| `${KeyKind} key refused`
