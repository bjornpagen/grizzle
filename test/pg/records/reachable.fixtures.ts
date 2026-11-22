/**
 * What the reachable records property of reachable.test.ts reads: its space of shapes, holders and retirements, the
 * model of what each retirement releases, and its case.
 */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { pg, retirement, Sha256, sha256 } from "#compiler/public/fields.ts"
import {
	login,
	on,
	reachable,
	records,
	recordsFacts,
	recordsQuery,
	relation,
	retirable,
	role,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { RecordsRelation } from "#compiler/types/schema/records.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	type AttachedCase,
	attachedCaseGen,
	shelfId,
	shelvesFacts,
	shelvesRelations
} from "#test/pg/records/attached.fixtures.ts"
import { shapeQuery } from "#test/support/agreement/records.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { shelvesNamed } from "#test/support/fixtures/records/shelves.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Where a case's holders stand: Ref alone, a body of Root; Ref and Cite, both bodies of Root; or Ref, Root's body,
 * and Cite, the body of Batch, a unit of its own.
 */
type HolderLayout = "ref" | "refAndCite" | "refAndBatchCite"

/** A retirable unit's header: Root, or Batch where the layout has it. */
type Unit = "Root" | "Batch"

/** One group of a unit: its header and its key. */
interface Group {
	readonly unit: Unit
	readonly id: number
}

/** One retirement call: the groups it retires, each unit's, as ChangeSet.retire takes them. */
interface Retirement {
	readonly groups: Arr.NonEmptyReadonlyArray<Group>
}

/**
 * A case: the records' shape and the Shelves facts their query reads (attached.fixtures.ts); where the holders stand;
 * the rows of Ref, each a root and the key it names, its `n` its place among its root's rows, so a root names a key as
 * often as it likes; the rows of Cite, each a group and the key it names, at most one per pair, Cite's key; whether a key
 * no holder names is stored beside them; and the retirements, in order, each a call of its own.
 *
 * A key k is the digest of the one byte k: the held keys 1 to 3, the unheld one 0.
 */
export interface ReachableCase {
	readonly attached: AttachedCase
	readonly layout: HolderLayout
	readonly refs: ReadonlyArray<{ readonly root: number; readonly key: number }>
	readonly cites: ReadonlyArray<{ readonly by: number; readonly key: number }>
	readonly unheld: boolean
	readonly retirements: Arr.NonEmptyReadonlyArray<Retirement>
}

/** The key no holder names, stored beside the held ones where a case draws it. */
const unheldKey = 0

/** The digest a key stands for: the SHA-256 of its one byte. */
const digestOf = (key: number): Sha256 => Sha256.ofBytes(Uint8Array.of(key))

/** The group `id` of `unit`. */
const group = (unit: Unit, id: number): Group => ({ unit, id })

/** Every group a layout's units hold: Root's 1 to 3, and Batch's 1 and 2 where it has Batch. */
const groupsOf = (layout: HolderLayout): Arr.NonEmptyReadonlyArray<Group> => [
	group("Root", 1),
	group("Root", 2),
	group("Root", 3),
	...(layout === "refAndBatchCite" ? [group("Batch", 1), group("Batch", 2)] : [])
]

/** The unit whose groups Cite's `by` names: Batch where the layout has it, Root otherwise. */
const citeUnit = (layout: HolderLayout): Unit => (layout === "refAndBatchCite" ? "Batch" : "Root")

const sameGroup = (a: Group, b: Group): boolean => a.unit === b.unit && a.id === b.id

/** A retirement of a nonempty set of a layout's groups. */
const retirementGen =
	(layout: HolderLayout): Gen<Retirement> =>
	(source) => {
		const all = groupsOf(layout)
		const [first, ...rest] = Arr.dedupeWith(
			source.draw(array(element(all), { min: 1, max: all.length })),
			sameGroup
		)
		return { groups: [defined(first, "a retired group"), ...rest] }
	}

export const reachableCaseGen: Gen<ReachableCase> = (source) => {
	const layout = source.draw(element<HolderLayout>(["ref", "refAndCite", "refAndBatchCite"]))
	const key = int(1, 3)
	const cites = citeGroups(layout)
	const [first, ...rest] = source.draw(array(retirementGen(layout), { min: 1, max: 3 }))
	return {
		attached: source.draw(attachedCaseGen),
		layout,
		refs: source.draw(
			array((s) => ({ root: s.draw(int(1, 3)), key: s.draw(key) }), { min: 1, max: 5 })
		),
		cites: Arr.dedupeWith(
			source.draw(
				array((s) => ({ by: s.draw(int(1, cites)), key: s.draw(key) }), {
					min: 0,
					max: layout === "ref" ? 0 : 3
				})
			),
			(a, b) => a.by === b.by && a.key === b.key
		),
		unheld: source.draw(boolean),
		retirements: [defined(first, "a retirement"), ...rest]
	}
}

/** How many groups Cite's `by` ranges over: Batch's two, or Root's three. */
const citeGroups = (layout: HolderLayout): number => (layout === "refAndBatchCite" ? 2 : 3)

/** One holder row: its relation, the group of its unit it lies in, and the key it names. */
interface Held {
	readonly relation: "Ref" | "Cite"
	readonly group: Group
	readonly key: number
}

/** Every holder row of a case: Ref's, each in its root's group, and Cite's, each in its unit's group `by`. */
const heldOf = (c: ReachableCase): ReadonlyArray<Held> => [
	...Arr.map(c.refs, (r): Held => ({
		relation: "Ref",
		group: { unit: "Root", id: r.root },
		key: r.key
	})),
	...Arr.map(c.cites, (x): Held => ({
		relation: "Cite",
		group: { unit: citeUnit(c.layout), id: x.by },
		key: x.key
	}))
]

/** The keys a case stores records at: every key a holder names, and the unheld key where it draws one. */
const storedKeys = (c: ReachableCase): ReadonlyArray<number> =>
	Arr.sort(
		Arr.dedupe([...Arr.map(heldOf(c), (h) => h.key), ...(c.unheld ? [unheldKey] : [])]),
		Order.Number
	)

/** The rows each relation of the records holds at each stored key, by the relation's name. */
type RowsByKey = Readonly<Record<string, ReadonlyMap<number, number>>>

/** A relation's change as an outcome counts it, apart from its name. */
interface Change {
	readonly added: bigint
	readonly deleted: bigint
	readonly put: bigint
}

const noChange: Change = Object.freeze({ added: 0n, deleted: 0n, put: 0n })

/** What the model expects of one retirement: its outcome's kind and its nonzero counts, and what it took and released. */
interface ModelStep {
	readonly kind: "accepted" | "unchanged"
	readonly counts: ReadonlyArray<{ readonly relation: string } & Change>
	/** Each key it removed a holder row of: the rows it removed naming it, and those left naming it. */
	readonly took: ReadonlyArray<{
		readonly key: number
		readonly gone: Arr.NonEmptyReadonlyArray<Held>
		readonly left: ReadonlyArray<Held>
	}>
	/** The stored keys it released: each it left no holder row naming. */
	readonly released: ReadonlyArray<number>
	/** The stored keys after it: those it found stored and did not release. */
	readonly present: ReadonlyArray<number>
}

/**
 * The model of a case's retirements: a group's retirement removes every holder row of it, and a stored key that a
 * retirement leaves no holder row naming, some holder row having named it before, is released, its rows gone from
 * every relation of the records. A key no holder ever named stays. Each call's outcome counts the groups it retires
 * anew as puts of their headers, the holder rows it removes as deletes of their relations, and the records' rows it
 * releases as deletes of theirs, nothing for a group already retired; accepted where any count is nonzero.
 */
const modelOf = (c: ReachableCase, rows: RowsByKey): ReadonlyArray<ModelStep> => {
	const held = heldOf(c)
	const steps: Array<ModelStep> = []
	let retired: ReadonlyArray<Group> = []
	let present = storedKeys(c)
	for (const r of c.retirements) {
		const anew = Arr.filter(r.groups, (g) => !Arr.some(retired, (x) => sameGroup(x, g)))
		const after = [...retired, ...anew]
		const alive = (h: Held, gone: ReadonlyArray<Group>): boolean =>
			!Arr.some(gone, (g) => sameGroup(g, h.group))
		const removed = Arr.filter(held, (h) => alive(h, retired) && !alive(h, after))
		const took = Arr.flatMap(Arr.dedupe(Arr.map(removed, (h) => h.key)), (key) => {
			const [first, ...rest] = Arr.filter(removed, (h) => h.key === key)
			return first === undefined
				? []
				: [
						{
							key,
							gone: [first, ...rest] as const,
							left: Arr.filter(held, (h) => h.key === key && alive(h, after))
						}
					]
		})
		const released = Arr.filter(present, (k) =>
			Arr.some(took, (t) => t.key === k && !Arr.isReadonlyArrayNonEmpty(t.left))
		)
		const changes = new Map<string, Change>()
		const add = (relation: string, change: Change): void => {
			const before = changes.get(relation) ?? noChange
			changes.set(relation, {
				added: before.added + change.added,
				deleted: before.deleted + change.deleted,
				put: before.put + change.put
			})
		}
		for (const g of anew) {
			add(g.unit, { ...noChange, put: 1n })
		}
		for (const h of removed) {
			add(h.relation, { ...noChange, deleted: 1n })
		}
		for (const [relationName, byKey] of Rec.toEntries(rows)) {
			for (const k of released) {
				add(relationName, { ...noChange, deleted: BigInt(byKey.get(k) ?? 0) })
			}
		}
		const counts = Arr.sort(
			Arr.filter(
				Arr.map([...changes], ([relationName, change]) => ({ relation: relationName, ...change })),
				(x) => x.added !== 0n || x.deleted !== 0n || x.put !== 0n
			),
			Order.mapInput(Order.String, (x: { readonly relation: string }) => x.relation)
		)
		present = Arr.filter(present, (k) => !released.includes(k))
		retired = after
		steps.push({
			kind: Arr.isReadonlyArrayNonEmpty(counts) ? "accepted" : "unchanged",
			counts,
			took,
			released,
			present
		})
	}
	return steps
}

/**
 * What a case reaches, by its model: how a key a retirement took a holder row of stayed or went.
 *
 * - kept by a holder of its retired holder's own relation: another row of a relation the retirement removed a row of
 *   names it still;
 * - kept by another relation's holder alone: every row that names it still is of a relation the retirement removed no
 *   row of naming it;
 * - kept by another unit's holder alone: every row that names it still lies in a unit the retirement removed no row of
 *   naming it;
 * - released after an earlier retirement kept it;
 * - released by retiring several of its groups at once;
 * - released though one group named it twice;
 * - released by Batch's retirement, Batch's own function releasing it;
 * - released with rows below the root: a relation of the records but the root held rows at it;
 * - released at depth three: the records held a spine's ink or a chapter's remark at it;
 * - released with an arm's rows: the records held a paper or digital arm's row at it;
 * - an unheld key kept beside a release.
 */
export type ReachableFeature =
	| "kept by a holder of its retired holder's own relation"
	| "kept by another relation's holder alone"
	| "kept by another unit's holder alone"
	| "released after an earlier retirement kept it"
	| "released by retiring several of its groups at once"
	| "released though one group named it twice"
	| "released by Batch's retirement"
	| "released with rows below the root"
	| "released at depth three"
	| "released with an arm's rows"
	| "an unheld key kept beside a release"

/** Whether the records of a case hold a row three relations deep at a key: a spine's ink, or a chapter's remark. */
const deep = (c: ReachableCase): boolean => {
	const shape = c.attached.shape.books
	const books = c.attached.facts.books
	const inked = Option.exists(shape.spine, (s) => Option.isSome(s.ink))
	const remarked =
		Option.exists(shape.chapters, (ch) => Option.isSome(ch.remark)) &&
		Arr.some(books, (b) => Arr.some(b.chapters, (ch) => Option.isSome(ch.remark)))
	return Arr.isReadonlyArrayNonEmpty(books) && (inked || remarked)
}

/** Whether the records of a case hold an arm's row at a key: a paper or a digital book read through its arm. */
const armed = (c: ReachableCase): boolean => {
	const shape = c.attached.shape.books
	const books = c.attached.facts.books
	return (
		(Option.exists(shape.paper, (a) => a.delivery === "arm") &&
			Arr.some(books, (b) => b.kind === "Paper")) ||
		(Option.exists(shape.digital, (a) => a.delivery === "arm") &&
			Arr.some(books, (b) => b.kind === "Digital"))
	)
}

/** The features a case reaches (ReachableFeature) by its model's steps over the rows it stored, `root` the records' root. */
const reachedOf = (
	c: ReachableCase,
	steps: ReadonlyArray<ModelStep>,
	rows: RowsByKey,
	root: string
): ReadonlyArray<ReachableFeature> => {
	const kept = new Set<number>()
	return Arr.dedupe(
		Arr.flatMap(steps, (step): ReadonlyArray<ReachableFeature> => {
			const reached = Arr.flatMap(
				step.took,
				({ key, gone, left }): ReadonlyArray<ReachableFeature> => {
					const feature = (holds: boolean, f: ReachableFeature): ReadonlyArray<ReachableFeature> =>
						holds ? [f] : []
					if (Arr.isReadonlyArrayNonEmpty(left)) {
						kept.add(key)
						return [
							...feature(
								Arr.some(left, (h) => Arr.some(gone, (g) => g.relation === h.relation)),
								"kept by a holder of its retired holder's own relation"
							),
							...feature(
								Arr.every(left, (h) => !Arr.some(gone, (g) => g.relation === h.relation)),
								"kept by another relation's holder alone"
							),
							...feature(
								Arr.every(left, (h) => !Arr.some(gone, (g) => g.group.unit === h.group.unit)),
								"kept by another unit's holder alone"
							)
						]
					}
					if (!step.released.includes(key)) {
						return []
					}
					const groups = Arr.dedupeWith(
						Arr.map(gone, (h) => h.group),
						sameGroup
					)
					return [
						...feature(kept.has(key), "released after an earlier retirement kept it"),
						...feature(groups.length > 1, "released by retiring several of its groups at once"),
						...feature(groups.length < gone.length, "released though one group named it twice"),
						...feature(
							Arr.some(gone, (h) => h.group.unit === "Batch"),
							"released by Batch's retirement"
						),
						...feature(
							Arr.some(
								Rec.toEntries(rows),
								([name, byKey]) => name !== root && (byKey.get(key) ?? 0) > 0
							),
							"released with rows below the root"
						),
						...feature(deep(c), "released at depth three"),
						...feature(armed(c), "released with an arm's rows")
					]
				}
			)
			return c.unheld && Arr.isReadonlyArrayNonEmpty(step.released)
				? [...reached, "an unheld key kept beside a release"]
				: reached
		})
	)
}

const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])
const Batch = relation("Batch", { id: pg.integer, retired: retirement }, ["id"])
const Ref = relation("Ref", { root: pg.integer, n: pg.integer, digest: sha256 }, ["root", "n"])
const Cite = relation("Cite", { by: pg.integer, digest: sha256 }, ["by", "digest"])

/**
 * A case's query and records over Shelves, keyed by their row's digest alone as den's are, and the level that lists them
 * with the units and holders its layout states and reachable(on(records, "digest"), holders), under the installation's
 * `name`.
 */
const builtAt = (c: ReachableCase, name: string) => {
	const base = shelvesNamed(name)
	const query = shapeQuery(base, c.attached.shape)
	const kept = records("Kept", query, { digest: sha256 }, ["digest"])
	const target = on(kept, "digest")
	const level = (() => {
		switch (c.layout) {
			case "ref":
				return schema.extend(
					[base],
					levelNameAt(name, 1),
					[Root, Ref, ...kept.relations],
					[
						...kept.rules,
						retirable(Root, [on(Ref, "root")]),
						reachable(target, [on(Ref, "digest")])
					]
				)
			case "refAndCite":
				return schema.extend(
					[base],
					levelNameAt(name, 1),
					[Root, Ref, Cite, ...kept.relations],
					[
						...kept.rules,
						retirable(Root, [on(Ref, "root"), on(Cite, "by")]),
						reachable(target, [on(Ref, "digest"), on(Cite, "digest")])
					]
				)
			case "refAndBatchCite":
				return schema.extend(
					[base],
					levelNameAt(name, 1),
					[Root, Ref, Batch, Cite, ...kept.relations],
					[
						...kept.rules,
						retirable(Root, [on(Ref, "root")]),
						retirable(Batch, [on(Cite, "by")]),
						reachable(target, [on(Ref, "digest"), on(Cite, "digest")])
					]
				)
		}
	})()
	return { base, query, kept, level }
}

type Built = ReturnType<typeof builtAt>

/** The relations of a case's holders, as its layout lists them. */
const holderNames = (layout: HolderLayout): ReadonlyArray<string> =>
	layout === "ref" ? ["Ref"] : ["Ref", "Cite"]

/** The headers of a case's units. */
const unitNames = (layout: HolderLayout): Arr.NonEmptyReadonlyArray<Unit> =>
	layout === "refAndBatchCite" ? ["Root", "Batch"] : ["Root"]

/** The name of each relation of a case's records an insert takes apart: the root's and each one it states apart. */
const keptNames = (built: Built): ReadonlyArray<string> => {
	const apart: ReadonlyArray<{ readonly name: string }> = built.kept.apart
	return [built.kept.row.name, ...Arr.map(apart, (r) => r.name)]
}

/** The insert of the records and their holders in one ChangeSet, as den keeps a row beside its reference. */
const keepOf = (built: Built, layout: HolderLayout) =>
	changeSetOver
		.empty(built.level)
		.insertAll(
			Rec.fromEntries(
				Arr.map([...keptNames(built), ...holderNames(layout)], (n) => [n, []] as const)
			)
		)

/** The retirement of groups of each of a layout's units, in one ChangeSet. */
const retireOf = (built: Built, layout: HolderLayout) =>
	Arr.reduce(unitNames(layout), changeSetOver.empty(built.level), (cs, unit) =>
		cs.retire(unit === "Root" ? Root : Batch, [])
	)

/**
 * The login over a case's level: a writer that inserts every relation, the records and holders among them, and reads
 * every relation; and a retirer that retires each unit.
 */
const appOf = (built: Built, layout: HolderLayout) => {
	const writer = role(built.level, "writer", wholeEntriesOf(built.level), {
		insert: writableNamesOf(built.level)
	})
	const retirer = role(built.level, "retirer", wholeEntriesOf(built.level), {
		retire: unitNames(layout)
	})
	return login(built.level, "records_app", [writer, retirer], {
		workload: [
			workload(writer, { keep: keepOf(built, layout) }),
			workload(retirer, { retire: retireOf(built, layout) })
		]
	})
}

/** A case's stored rows, an outcome or a read back differs from the model's. */
class ReachableDisagreed extends Data.TaggedError("ReachableDisagreed")<{
	readonly message: string
}> {}

/**
 * The rows each relation of the records holds at each key, read as the owner: each relation carries the digest at its
 * key's first field, the owner key's one field.
 */
const rowsByKey = (installed: Installed, relations: ReadonlyArray<RecordsRelation>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const keyOfHex = new Map(
			Arr.map([unheldKey, 1, 2, 3], (k) => [Sha256.toHex(digestOf(k)), k] as const)
		)
		const counted = yield* Effect.forEach(relations, (r) => {
			const column = installed.names.column(
				r.name,
				defined(r.primaryKey[0], "a relation of records carrying the digest first")
			)
			return Effect.map(
				substrate.admin.queryValues(
					`SELECT encode(${column}, 'hex'), count(*)::text FROM ${printObjectName(installed.names.relation(r.name))} GROUP BY 1`,
					[]
				),
				(rows) =>
					[
						r.name,
						new Map(
							Arr.map(
								rows,
								([hex, count]) =>
									[
										defined(keyOfHex.get(String(hex)), "a stored digest of a drawn key"),
										Number(count)
									] as const
							)
						)
					] as const
			)
		})
		return Rec.fromEntries(counted)
	})

/** A relation's rows at each key, `key:count`, in order, as a disagreement prints them. */
const listed = (rows: RowsByKey): Readonly<Record<string, ReadonlyArray<string>>> =>
	Rec.map(rows, (byKey) =>
		Arr.sort(
			Arr.map([...byKey], ([k, n]) => `${k}:${n}`),
			Order.String
		)
	)

/** The rows `rows` holds at the keys `present` alone. */
const restricted = (rows: RowsByKey, present: ReadonlyArray<number>): RowsByKey =>
	Rec.map(rows, (byKey) => new Map(Arr.filter([...byKey], ([k]) => present.includes(k))))

/** The facts of one retirement call, each unit's groups by its header, every unit of the layout named. */
const retireFacts = (layout: HolderLayout, r: Retirement) =>
	Rec.fromEntries(
		Arr.map(
			unitNames(layout),
			(unit) =>
				[
					unit,
					Arr.map(
						Arr.filter(r.groups, (g) => g.unit === unit),
						(g) => ({ id: g.id })
					)
				] as const
		)
	)

/**
 * A case (see reachable.test.ts): Shelves and the case's level installed as one installation, the Shelves facts and every
 * group inserted, the query read, and its rows stored as the records at every stored key beside the holder rows in one
 * call; then each retirement, served, by the retirer. After each, its outcome and the rows of every relation of the
 * records at each key are the model's; at the end each key still stored reads back the rows the query delivered.
 */
export const reachableCase = (c: ReachableCase) =>
	Effect.gen(function* () {
		const { installed } = yield* installGenerated(
			(name) => {
				const built = builtAt(c, name)
				return { schema: built.level, logins: [appOf(built, c.layout)] }
			},
			{ label: "records", ambient: ordinarySession }
		)
		const at = builtAt(c, installed.declared)
		const app = appOf(at, c.layout)
		const writer = yield* openServedDb(installed, app.roles.writer, {})
		const served = yield* writer.serve({
			source: changeSetOver
				.empty(at.base)
				.insertAll(Rec.fromEntries(Arr.map(shelvesRelations, (n) => [n, []] as const))),
			groups: changeSetOver
				.empty(at.level)
				.insertAll(Rec.fromEntries(Arr.map(unitNames(c.layout), (u) => [u, []] as const))),
			found: at.query,
			keep: keepOf(at, c.layout),
			back: recordsQuery(at.level, at.kept)
		})
		const retirer = yield* openServedDb(installed, app.roles.retirer, {})
		const retiring = yield* retirer.serve({ retire: retireOf(at, c.layout) })
		yield* writeOnce(member(served, "source"))({
			params: {},
			facts: { insert: shelvesFacts(c.attached.facts) }
		})
		yield* writeOnce(member(served, "groups"))({
			params: {},
			facts: {
				insert: Rec.fromEntries(
					Arr.map(
						unitNames(c.layout),
						(unit) =>
							[
								unit,
								Arr.map(
									Arr.filter(groupsOf(c.layout), (g) => g.unit === unit),
									(g) => ({ id: g.id })
								)
							] as const
					)
				)
			}
		})
		const found = yield* readOnce(member(served, "found"))({
			params: { shelf: shelfId },
			facts: {}
		})
		const keys = storedKeys(c)
		yield* writeOnce(member(served, "keep"))({
			params: {},
			facts: {
				insert: {
					...recordsFacts(
						at.level,
						at.kept
					)(
						Arr.flatMap(found, (row) =>
							Arr.map(keys, (k) => [{ digest: digestOf(k) }, row] as const)
						)
					),
					Ref: Arr.map(c.refs, (r, i) => ({
						root: r.root,
						n: Arr.filter(Arr.take(c.refs, i), (x) => x.root === r.root).length,
						digest: digestOf(r.key)
					})),
					...(c.layout === "ref"
						? {}
						: { Cite: Arr.map(c.cites, (x) => ({ by: x.by, digest: digestOf(x.key) })) })
				}
			}
		})
		const before = yield* rowsByKey(installed, at.kept.relations)
		const steps = modelOf(c, before)
		for (const [i, r] of c.retirements.entries()) {
			const step = defined(steps[i], "the model's step of each retirement")
			const outcome = yield* writeOnce(member(retiring, "retire"))({
				params: {},
				facts: { retire: retireFacts(c.layout, r) }
			})
			if (outcome.kind === "refreshed") {
				return yield* new ReachableDisagreed({ message: "a retirement answered refreshed" })
			}
			const answered = {
				kind: outcome.kind,
				counts:
					outcome.kind === "accepted"
						? Arr.map(
								Arr.filter(
									outcome.counts,
									(x) => x.added !== 0n || x.deleted !== 0n || x.put !== 0n
								),
								(x): { readonly relation: string } & Change => ({
									relation: x.relation,
									added: x.added,
									deleted: x.deleted,
									put: x.put
								})
							)
						: []
			}
			const counted = exactValue(answered, { kind: step.kind, counts: step.counts })
			if (Option.isSome(counted)) {
				return yield* new ReachableDisagreed({
					message: `retirement ${i} of ${Formatter.format(r.groups)} answered ${Formatter.format(answered)}, where the model releases ${Formatter.format(step.released)}: ${counted.value}`
				})
			}
			const after = yield* rowsByKey(installed, at.kept.relations)
			const stored = exactValue(listed(after), listed(restricted(before, step.present)))
			if (Option.isSome(stored)) {
				return yield* new ReachableDisagreed({
					message: `after retirement ${i} of ${Formatter.format(r.groups)} the records hold ${Formatter.format(listed(after))}, where they held ${Formatter.format(listed(before))} and the model keeps ${Formatter.format(step.present)}: ${stored.value}`
				})
			}
		}
		const last = defined(steps[steps.length - 1], "the model's last step")
		for (const k of last.present) {
			const back = yield* readOnce(member(served, "back"))({
				params: { digest: digestOf(k) },
				facts: {}
			})
			const read = exactValue(back, found)
			if (Option.isSome(read)) {
				return yield* new ReachableDisagreed({
					message: `key ${k}'s records read back ${Formatter.format(back)} after the retirements, where the query delivered ${Formatter.format(found)}: ${read.value}`
				})
			}
		}
		return reachedOf(c, steps, before, at.kept.row.name)
	})
