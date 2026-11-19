/** What the properties of levels.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Data, Effect, Option, Record as Rec, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { ChangeSet, type Law } from "#compiler/public/changeset.ts"
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
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { Uuid } from "#compiler/scalar/values/uuid.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

export const Code = contract("Code", uuid)

const Kind = closed.ordered("Kind", ["Practice", "Test"])

export const Item = relation("Item", { id: Code, n: pg.integer }, ["id"])

export const Sitting = relation("Sitting", { id: uuid, item: Code, kind: closedId(Kind) }, ["id"])

/** A level of the installation. */
export type Level = "lower" | "upper"

/** A role of the installation, by the level whose login holds it. */
export type LevelRole = "author" | "learner"

/**
 * The two levels and their worlds under `name`, the upper level under its allocated name (levelNameAt), each login's
 * workload holding its role's writes of the facts each call gives: the author adds and deletes items, and the learner
 * adds and deletes sittings and reads the fused query, sittings joined to their items, and the lower level's items.
 */
const levelsAt = (name: string) => {
	const lowerOwn = { Kind, Item }
	const upperOwn = { Sitting }
	const lower = schema(name, Rec.values(lowerOwn), [])
	const upper = schema.extend(lower, levelNameAt(name, 1), Rec.values(upperOwn), [
		contained(on(Sitting, "item"), on(Item, "id"))
	])
	const authorWrites = writableNamesOf(lower)
	const learnerWrites = ["Sitting"] as const
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
					fused,
					items
				})
			]
		})
	}
}

/** The ids a case draws from: few, so sittings meet items and deletions meet references. */
const POOL = 4

const ids: Arr.NonEmptyReadonlyArray<Uuid> = [
	"00000000-0000-4000-8000-000000000000",
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
	"00000000-0000-4000-8000-000000000003"
]

export const idAt = (i: number): Uuid => defined(ids[i], `id ${i} of the pool`)

type Op =
	| { readonly kind: "addItem"; readonly id: number; readonly n: number }
	| { readonly kind: "dropItem"; readonly id: number }
	| {
			readonly kind: "addSitting"
			readonly id: number
			readonly item: number
			readonly test: boolean
	  }
	| { readonly kind: "dropSitting"; readonly id: number }

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
	[1, (s) => ({ kind: "dropSitting", id: s.draw(idGen) })]
])

export const historyGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 10 })

export type Feature =
	| "an item added"
	| "an item deleted"
	| "a held item's deletion refused from above"
	| "a sitting added"
	| "a dangling sitting refused"
	| "a sitting deleted"
	| "a fused read of a sitting"

/** The facts the host holds: items by id with their n, sittings by id with their item and kind. */
export interface Facts {
	readonly items: Map<number, number>
	readonly sittings: Map<number, { readonly item: number; readonly test: boolean }>
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export const disagreed = (message: string) => Effect.fail(new Disagreed({ message }))

/** A refusal names exactly `law`. */
export const namesExactly = (
	outcome: { readonly kind: string },
	refused: ReadonlyArray<Law> | undefined,
	law: Law
): boolean =>
	outcome.kind === "refused" && refused?.length === 1 && Option.isNone(exact(refused[0], law))

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

const levelRelations: Arr.NonEmptyReadonlyArray<string> = [Item.name, Sitting.name]

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

/** The installation of the two levels and their logins under an allocated name, and the levels under that name. */
export const installedLevels = Effect.gen(function* () {
	const generated = yield* installGenerated(
		(name) => {
			const at = levelsAt(name)
			return { schema: at.upper, logins: [at.authorApp, at.app] }
		},
		{ label: "levels", ambient: ordinarySession }
	)
	const done = generated.installed
	return { generated, done, at: levelsAt(done.declared) }
})

export const quote = (text: string) => `'${Str.replaceAll("'", "''")(text)}'`

export const columnOf = (field: string) => quote(identifierOf(identity.column(parsedName(field))))
