/** What the properties of levels.test.ts read: its spaces, models and helpers. */

import { aimed, array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Data, Effect, Record as Rec, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	login,
	on,
	relation,
	role,
	schema,
	select,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"

import { defined } from "@bjornpagen/testing/assert"
import { ordinarySession } from "#test/support/ambient.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { Id, type IdValue } from "#test/support/ids.ts"
import { type Generated, generatedTemplate } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { SubstrateCase } from "#test/support/substrate/substrate.ts"

export const Code = contract("Code", uuid)

const Kind = closed.ordered("Kind", ["Practice", "Test"])

export const Item = relation("Item", { id: Code, n: pg.integer }, ["id"])

export const Sitting = relation("Sitting", { id: Id, item: Code, kind: closedId(Kind) }, ["id"])

/** An item the upper level approves, by its code. */
const Approved = relation("Approved", { id: Code }, ["id"])

/** The items of n at least 5, the lower level's selection the upper level's laws read. */
const heldItems = select(Item, (i) => i.ge(i.n, 5))

/** The threshold of n at and above which an item is held (heldItems), as the host model reads it. */
export const HELD_AT = 5

/** A level of the installation. */
export type Level = "lower" | "upper"

/** A role of the installation, by the level whose login holds it. */
export type LevelRole = "author" | "learner"

/**
 * The two levels and their worlds under `name`, the upper level under its allocated name (levelNameAt), each login's
 * workload holding its role's writes of the facts each call gives: the author adds and deletes items, and the learner
 * adds and deletes sittings and approvals and reads the fused query, sittings joined to their items, and the lower
 * level's items. The upper level states three containments that reach the lower level's Item: every sitting's item is
 * an item, a plain foreign key into the lower table; every held item, a selection of the lower relation, is approved
 * above; and every test sitting's item is a held item, a selection of the lower relation as a target.
 */
const levelsAt = (name: string) => {
	const lowerOwn = { Kind, Item }
	const upperOwn = { Sitting, Approved }
	const lower = schema(name, Rec.values(lowerOwn), [])
	const laws = {
		"a sitting's item": contained(on(Sitting, "item"), on(Item, "id")),
		"a held item approved": contained(on(heldItems, "id"), on(Approved, "id")),
		"a test's item held": contained(
			on(
				select(Sitting, (s) => s.eq(s.kind, "Test")),
				"item"
			),
			on(heldItems, "id")
		)
	} as const
	const upper = schema.extend([lower], levelNameAt(name, 1), Rec.values(upperOwn), Rec.values(laws))
	const authorWrites = writableNamesOf(lower)
	const learnerWrites = ["Sitting", "Approved"] as const
	const author = role(lower, "author", wholeEntriesOf(lower), { write: authorWrites })
	const learner = role(upper, "learner", wholeEntriesOf(upper), { write: learnerWrites })
	/** The relations each level declares itself, as its schema(...) or schema.extend(...) was given them. */
	const declares: { readonly [L in Level]: ReadonlyArray<string> } = {
		lower: Rec.keys(lowerOwn),
		upper: Rec.keys(upperOwn)
	}
	/** The relations each role writes, as its role(...) was given them. */
	const writes: { readonly [R in LevelRole]: ReadonlyArray<string> } = {
		author: authorWrites,
		learner: learnerWrites
	}
	const fused = query(upper).rule((r) => {
		const { id, item, kind } = v(Sitting, "sitting")
		const { n } = v(Item, "item")
		return r.match(Sitting, { id, item, kind }).match(Item, { id: item, n }).find({ id, n })
	})
	const items = query(lower).rule((r) => {
		const { id, n } = v(Item, "item")
		return r.match(Item, { id, n }).find({ id, n })
	})
	return {
		lower,
		upper,
		laws,
		declares,
		writes,
		author,
		learner,
		authorApp: login(lower, "author_app", [author], {
			workload: [
				workload(author, {
					addItem: ChangeSet.empty(lower).insert(Item, []),
					dropItem: ChangeSet.empty(lower).delete(Item, [])
				})
			]
		}),
		app: login(upper, "app", [learner], {
			workload: [
				workload(learner, {
					addSitting: ChangeSet.empty(upper).insert(Sitting, []),
					dropSitting: ChangeSet.empty(upper).delete(Sitting, []),
					addApproval: ChangeSet.empty(upper).insert(Approved, []),
					dropApproval: ChangeSet.empty(upper).delete(Approved, []),
					fused,
					items
				})
			]
		})
	}
}

/** The ids a case draws from: few, so sittings meet items and deletions meet references. */
const POOL = 4

const ids: Arr.NonEmptyReadonlyArray<IdValue> = [
	Id("00000000-0000-4000-8000-000000000000"),
	Id("00000000-0000-4000-8000-000000000001"),
	Id("00000000-0000-4000-8000-000000000002"),
	Id("00000000-0000-4000-8000-000000000003")
]

export const idAt = (i: number): IdValue => defined(ids[i], `id ${i} of the pool`)

export type Op =
	| { readonly kind: "addItem"; readonly id: number; readonly n: number }
	| { readonly kind: "dropItem"; readonly id: number }
	| {
			readonly kind: "addSitting"
			readonly id: number
			readonly item: number
			readonly test: boolean
	  }
	| { readonly kind: "dropSitting"; readonly id: number }
	| { readonly kind: "addApproval"; readonly id: number }
	| { readonly kind: "dropApproval"; readonly id: number }

const idGen: Gen<number> = int(0, POOL - 1)

const opGen: Gen<Op> = weighted<Op>([
	[3, (s) => ({ kind: "addItem", id: s.draw(idGen), n: s.draw(int(0, 9)) })],
	[2, (s) => ({ kind: "dropItem", id: s.draw(idGen) })],
	[
		3,
		(s) => ({
			kind: "addSitting",
			id: s.draw(idGen),
			item: s.draw(idGen),
			test: s.draw(element([false, true]))
		})
	],
	[1, (s) => ({ kind: "dropSitting", id: s.draw(idGen) })],
	[2, (s) => ({ kind: "addApproval", id: s.draw(idGen) })],
	[1, (s) => ({ kind: "dropApproval", id: s.draw(idGen) })]
])

const historyGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 12 })

/** An n of a held item. */
const heldN: Gen<number> = int(HELD_AT, 9)

/** A history that opens with the ops `prefix` draws, then goes on as any history does, a few ops more. */
const opening =
	(prefix: (source: Parameters<Gen<number>>[0]) => ReadonlyArray<Op>): Gen<ReadonlyArray<Op>> =>
	(source) => [...prefix(source), ...source.draw(array(opGen, { min: 0, max: 6 }))]

/** An n of an item that is not held. */
const unheldN: Gen<number> = int(0, HELD_AT - 1)

/**
 * A history, aimed at each situation only a sequence of ops reaches: a sitting of an item added, read, deleted, and
 * holding its item's deletion back from above; a test sitting of an item that is not held; and what the selected laws
 * reach only through an item made held: an approved held item, an unapproved one, an approval deleted from under one,
 * and a test sitting of one.
 */
export const historySpace = aimed<ReadonlyArray<Op>, Feature>(historyGen, [
	[
		"a sitting deleted",
		opening((s) => {
			const [id, item] = [s.draw(idGen), s.draw(idGen)]
			return [
				{ kind: "addItem", id: item, n: s.draw(unheldN) },
				{ kind: "addSitting", id, item, test: false },
				{ kind: "dropSitting", id }
			]
		})
	],
	[
		"a held item's deletion refused from above",
		opening((s) => {
			const item = s.draw(idGen)
			return [
				{ kind: "addItem", id: item, n: s.draw(unheldN) },
				{ kind: "addSitting", id: s.draw(idGen), item, test: false },
				{ kind: "dropItem", id: item }
			]
		})
	],
	[
		"a test sitting of an unselected item refused",
		opening((s) => {
			const item = s.draw(idGen)
			return [
				{ kind: "addItem", id: item, n: s.draw(unheldN) },
				{ kind: "addSitting", id: s.draw(idGen), item, test: true }
			]
		})
	],
	[
		"a selected item added",
		opening((s) => {
			const id = s.draw(idGen)
			return [
				{ kind: "addApproval", id },
				{ kind: "addItem", id, n: s.draw(heldN) }
			]
		})
	],
	[
		"an unapproved selected item refused from above",
		opening((s) => [{ kind: "addItem", id: s.draw(idGen), n: s.draw(heldN) }])
	],
	[
		"an approval's deletion refused",
		opening((s) => {
			const id = s.draw(idGen)
			return [
				{ kind: "addApproval", id },
				{ kind: "addItem", id, n: s.draw(heldN) },
				{ kind: "dropApproval", id }
			]
		})
	],
	[
		"a test sitting added",
		opening((s) => {
			const id = s.draw(idGen)
			return [
				{ kind: "addApproval", id },
				{ kind: "addItem", id, n: s.draw(heldN) },
				{ kind: "addSitting", id: s.draw(idGen), item: id, test: true }
			]
		})
	]
])

export type Feature =
	| "an item added"
	| "an item deleted"
	| "a held item's deletion refused from above"
	| "a sitting added"
	| "a dangling sitting refused"
	| "a sitting deleted"
	| "a fused read of a sitting"
	| "a selected item added"
	| "an unapproved selected item refused from above"
	| "an approval added"
	| "an approval's deletion refused"
	| "an approval deleted"
	| "a test sitting added"
	| "a test sitting of an unselected item refused"

/** The facts the host holds: items by id with their n, sittings by id with their item and kind, and approvals. */
export interface Facts {
	readonly items: ReadonlyMap<number, number>
	readonly sittings: ReadonlyMap<number, { readonly item: number; readonly test: boolean }>
	readonly approved: ReadonlySet<number>
}

/** A law the upper level states, by its key in levelsAt's laws. */
export type LawName = "a sitting's item" | "a held item approved" | "a test's item held"

/**
 * The laws restated over the facts, each one the state breaks: a sitting whose item is no item; a held item, n at
 * least HELD_AT, that no approval names; a test sitting whose item is no held item.
 */
export const brokenLaws = (f: Facts): ReadonlyArray<LawName> => {
	const sittings = [...f.sittings.values()]
	const held = (item: number): boolean => (f.items.get(item) ?? -1) >= HELD_AT
	return [
		...(Arr.some(sittings, (s) => !f.items.has(s.item)) ? ["a sitting's item" as const] : []),
		...(Arr.some([...f.items], ([id, n]) => n >= HELD_AT && !f.approved.has(id))
			? ["a held item approved" as const]
			: []),
		...(Arr.some(sittings, (s) => s.test && !held(s.item)) ? ["a test's item held" as const] : [])
	]
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export const disagreed = (message: string) => Effect.fail(new Disagreed({ message }))

/** Rows of an id and an n, each as its plain fields, for a comparison as a set. */
export const plain = (rows: ReadonlyArray<{ readonly id: string; readonly n: number }>) =>
	Arr.map(rows, (r) => ({ id: r.id, n: r.n }))

/** Two reads of rows of an id and an n agree as sets: each row once, in any order. */
export const sameRows = set(structuralHash, exact)

/**
 * A fact of the installed catalog the levels' declarations decide: a declared relation's table in a level's schema; a
 * role's privileges on a declared relation's table; the upper level's containment held by a deferred foreign key from
 * its table into the lower one; and its two columns of the root's one contract domain.
 */
export type CatalogFact =
	| Readonly<{ kind: "placed"; relation: string; level: Level }>
	| Readonly<{ kind: "privileged"; role: LevelRole; relation: string }>
	| Readonly<{ kind: "containment" }>
	| Readonly<{ kind: "domain" }>

const levels = ["lower", "upper"] as const satisfies ReadonlyArray<Level>

const levelRoles = ["author", "learner"] as const satisfies ReadonlyArray<LevelRole>

const levelRelations: Arr.NonEmptyReadonlyArray<string> = [Item.name, Sitting.name, Approved.name]

const factKinds = ["placed", "privileged", "containment", "domain"] as const

/** Every fact of the box: each relation at each level, each role on each relation, and the two of the containment. */
export const catalogFactGen: Gen<CatalogFact> = (source) => {
	const kind = source.draw(element(factKinds))
	switch (kind) {
		case "placed":
			return {
				kind,
				relation: source.draw(element(levelRelations)),
				level: source.draw(element(levels))
			}
		case "privileged":
			return {
				kind,
				role: source.draw(element(levelRoles)),
				relation: source.draw(element(levelRelations))
			}
		case "containment":
		case "domain":
			return { kind }
	}
}

export type CatalogFeature =
	| "a table in its level's schema"
	| "no table in another level's schema"
	| "privileges on a table the role writes"
	| "no privilege on a table the role does not write"
	| "the containment across the levels"
	| "one contract domain across the levels"

/**
 * What the declarations say of a fact, and the situation it is: a relation's table is in a level's schema exactly when
 * that level declares the relation; a role holds a privilege on a table exactly when it writes the relation, reading
 * every other through its views; the containment and the domain hold.
 */
export const expectedOf = (
	declared: ReturnType<typeof levelsAt>,
	fact: CatalogFact
): readonly [holds: boolean, situation: CatalogFeature] => {
	switch (fact.kind) {
		case "placed": {
			const holds = Arr.contains(declared.declares[fact.level], fact.relation)
			return [holds, holds ? "a table in its level's schema" : "no table in another level's schema"]
		}
		case "privileged": {
			const holds = Arr.contains(declared.writes[fact.role], fact.relation)
			return [
				holds,
				holds
					? "privileges on a table the role writes"
					: "no privilege on a table the role does not write"
			]
		}
		case "containment":
			return [true, "the containment across the levels"]
		case "domain":
			return [true, "one contract domain across the levels"]
	}
}

/**
 * The two levels and their logins drafted and served as `grizzle generate` drafts them, once per member under the
 * template's name (install-migrate.ts generatedTemplate), where the search installed them once before its cases.
 */
export const levelsTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "levels",
	content: { levels: "levels" },
	build: (name) => {
		const at = levelsAt(name)
		return { schema: at.upper, logins: [at.authorApp, at.app] }
	},
	ambient: ordinarySession
})

/** A case's installation of the levels over its clone of the template (levelsTemplate), and the levels under its name. */
export const levelsIn = (taken: SubstrateCase<Generated>) => ({
	generated: taken.value,
	done: taken.value.installed,
	at: levelsAt(taken.value.installed.declared)
})

export const quote = (text: string) => `'${Str.replaceAll("'", "''")(text)}'`

export const columnOf = (field: string) => quote(identifierOf(identity.column(parsedName(field))))
