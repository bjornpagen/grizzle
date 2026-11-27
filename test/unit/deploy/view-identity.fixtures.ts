/** What the property of view-identity.test.ts reads: its space, the schema's versions and the stored tables they draft. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Number as Num, Option, Order } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { compareIdentities, type Identity, identity } from "#compiler/core/identity.ts"
import type { Slot, Step } from "#compiler/deploy/diff/plan.ts"
import { writeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, key, on, relation, schema, unit } from "#compiler/public/schema.ts"
import type { CreateStoredTable, Expr } from "#compiler/sql/ast.ts"
import { lit, types } from "#compiler/sql/build.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	asDrafted,
	compile,
	draftChain,
	fromEmpty,
	fromSnapshot,
	noDeclarations
} from "#test/support/migrate/kit.ts"

/** A stored derived relation of the schema: Ones and Twos over T, at level 1, and Fives over Ones, at level 2. */
export const views = ["Ones", "Twos", "Fives"] as const
export type View = (typeof views)[number]

/** Each stored relation's derived level. */
const levels: Readonly<Record<View, number>> = { Ones: 1, Twos: 1, Fives: 2 }

/**
 * `some` in the install order of a version's stored tables (`identities`): level by level, the tables of one level in
 * the order of the identities their names are minted from, each its canonical form's (core/identity.ts view, its form's
 * digest), as the installation orders a hashed name (physical/obligations/graph.ts), never by the name's own digest,
 * which is no order: two of one level stand in an order no relation's name decides.
 */
export const inInstallOrder = (
	identities: ReadonlyMap<View, Identity<"view">>,
	some: ReadonlyArray<View>
): ReadonlyArray<View> => {
	const minted = (view: View): Identity<"view"> =>
		defined(identities.get(view), `${view}'s canonical identity`)
	return Arr.sort(
		some,
		Order.combine(
			Order.mapInput(Order.Number, (view: View) => levels[view]),
			Order.mapInput(
				(x: Identity<"view">, y: Identity<"view">) => Num.sign(compareIdentities(x, y)),
				minted
			)
		)
	)
}

/**
 * What the second version changes: nothing; how Ones is lowered alone, its installed definition another lowering's of
 * the same definition (`lowering`), or one that calls a function of its schema the target no longer holds, as an
 * earlier lowering's helper the new one does without (`gone`); a key of T's `b`, which Ones and Twos then hold too
 * (`key`); Ones' definition; Twos'; or Fives', the stored relation above Ones.
 */
const changes = ["none", "lowering", "gone", "key", "Ones", "Twos", "Fives"] as const
export type Change = (typeof changes)[number]

export const changeGen: Gen<Change> = (s) => s.draw(element(changes))

/** The stored tables a change creates again, by the schema's own reads, in install order: each whose meaning or primary
 * key it changes, or whose installed definition reads what the target no longer holds, and every one above one, whose
 * definition names it. A lowering alone changes neither; T's key of `b` yields no other row, and though it is a key of
 * Ones and Twos too, narrower than their (doc, at), a stored table's primary key is its narrowest proven key that holds
 * its unit, (doc, at), the unit's fields first (analysis/theory/theory.ts storedPrimaryKey), so theirs stays and they
 * gain b's unique index beside it. */
export const recreatedBy = (change: Change): ReadonlyArray<View> => {
	switch (change) {
		case "none":
		case "lowering":
		case "key":
			return []
		case "gone":
		case "Ones":
			return ["Ones", "Fives"]
		case "Twos":
			return ["Twos"]
		case "Fives":
			return ["Fives"]
	}
}

/**
 * The schema at `version`: T's facts by document and place, in the unit Document, keyed by the document; Ones, those
 * of T whose `a` is one, and Twos, whose `a` is two, each stored at level 1; Fives, those of Ones whose `b` is five,
 * stored at level 2. The second version holds the change of a definition, Ones' `a` three, Twos' four or Fives' `b`
 * six, or T's key of `b`.
 */
const schemaOf = (change: Change, version: "first" | "second") => {
	const changed = (c: Change): boolean => version === "second" && change === c
	const T = relation("T", { doc: pg.integer, at: pg.integer, a: pg.integer, b: pg.integer }, [
		"doc",
		"at"
	])
	const Document = unit("Document", { doc: pg.integer })
	const Base = schema(
		"view_identity",
		[T],
		changed("key") ? [Document, key(on(T, "b"))] : [Document]
	)
	const selected = (a: number) =>
		query(Base).rule((r) => {
			const { doc, at, b } = v(T, "t")
			return r.match(T, { doc, at, a, b }).find({ doc, at, b })
		})
	const Ones = derived("Ones", selected(changed("Ones") ? 3 : 1))
	const Twos = derived("Twos", selected(changed("Twos") ? 4 : 2))
	const Level1 = schema.extend([Base], "view_identity_1", [Ones, Twos], [])
	const Fives = derived(
		"Fives",
		query(Level1).rule((r) => {
			const { doc, at } = v(Ones, "ones")
			return r.match(Ones, { doc, at, b: changed("Fives") ? 6 : 5 }).find({ doc, at })
		})
	)
	return schema.extend([Level1], "view_identity_2", [Fives], [])
}

/** The stored relation a stored table's name names, by the identifier its derived relation's record gives it. */
const viewNamed = (snapshot: DeploySnapshot, name: string): View =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(views, (view) => snapshot.theory.relations[view]?.ident === name)
		),
		`a view of the schema, not ${name}`
	)

/** Each stored relation's CREATE TABLE as `snapshot` records it. */
export const recordedViews = (snapshot: DeploySnapshot): ReadonlyMap<View, CreateStoredTable> =>
	new Map(
		Arr.flatMap(snapshot.manifest.objects, (o) => {
			const [create] = o.ddl
			return create?.kind === "createStoredTable"
				? [[viewNamed(snapshot, create.name.name), create] as const]
				: []
		})
	)

/** How an earlier lowering installed Ones: under OFFSET 0, which keeps every row, or under an OFFSET a function of its
 * schema computes, which the target no longer holds. */
type Relowering = "lowering" | "gone"

/** The OFFSET of Ones' query in `schema`, as `relowering` installed it. */
const offsetOf = (relowering: Relowering, schema: string): Expr => {
	switch (relowering) {
		case "lowering":
			return lit.int(0, types.bigint)
		case "gone":
			return {
				kind: "call",
				fn: { kind: "qualified", schema, name: "earlier_helper", volatility: "IMMUTABLE" },
				args: [],
				star: false,
				distinct: false,
				orderBy: [],
				withinGroup: [],
				over: undefined
			}
	}
}

/** `snapshot` with Ones recorded as an earlier lowering of its definition installed it (Relowering). */
const relowered = (snapshot: DeploySnapshot, relowering: Relowering): DeploySnapshot => {
	const ident = defined(snapshot.theory.relations["Ones"], "Ones' record").ident
	return {
		...snapshot,
		manifest: {
			...snapshot.manifest,
			objects: Arr.map(snapshot.manifest.objects, (o) => {
				const [create, ...rest] = o.ddl
				return create?.kind === "createStoredTable" && create.name.name === ident
					? {
							...o,
							ddl: [
								{
									...create,
									query: { ...create.query, offset: offsetOf(relowering, create.name.schema) }
								},
								...rest
							]
						}
					: o
			})
		}
	}
}

/** A stored table a draft's step creates or fills, with the step's slot. */
export interface ViewStep {
	readonly view: View
	readonly slot: Slot
}

/**
 * What one draft does to the stored tables, in step order, the snapshot it continues and the one it leaves, and the
 * identity each stored table of its version is named from (`inInstallOrder`).
 */
export interface ViewDraft {
	readonly created: ReadonlyArray<ViewStep>
	readonly filled: ReadonlyArray<ViewStep>
	readonly steps: number
	readonly previous: DeploySnapshot
	readonly snapshot: DeploySnapshot
	readonly identities: ReadonlyMap<View, Identity<"view">>
}

const viewDraft = (
	previous: DeploySnapshot,
	snapshot: DeploySnapshot,
	steps: ReadonlyArray<Step>,
	identities: ReadonlyMap<View, Identity<"view">>
): ViewDraft => {
	const statements = Arr.flatMap(steps, (step) =>
		step.draft.kind === "statement" ? [{ slot: step.slot, statement: step.draft.statement }] : []
	)
	return {
		created: Arr.flatMap(statements, ({ slot, statement }) =>
			statement.kind === "createStoredTable"
				? [{ view: viewNamed(snapshot, statement.name.name), slot }]
				: []
		),
		filled: Arr.flatMap(statements, ({ slot, statement }) =>
			statement.kind === "fillStored"
				? [{ view: viewNamed(snapshot, statement.table.name), slot }]
				: []
		),
		steps: steps.length,
		previous,
		snapshot,
		identities
	}
}

/** The identity each stored relation of `desc` is named from: its canonical form's (analysis/derived/canonical.ts). */
const identitiesOf = (desc: ReturnType<typeof schemaOf>): ReadonlyMap<View, Identity<"view">> => {
	const checked = compile(desc, asDrafted).checked
	return new Map(
		Arr.map(views, (view) => [view, identity.view(checked.canonicalOf(view).digest)] as const)
	)
}

/** The two drafts of `change`: the first version's from no installation, and the second's over the first's snapshot as
 * its committed files read, with Ones relowered (`relowered`) where the change is an earlier lowering's. */
export const viewDrafts = (
	change: Change
): { readonly first: ViewDraft; readonly second: ViewDraft } => {
	const [first] = draftChain(
		[{ desc: schemaOf(change, "first"), options: asDrafted, declared: noDeclarations }],
		fromEmpty
	)
	const one = defined(first, "the first migration")
	/** The first snapshot as the next draft reads it, from the files generate wrote. */
	const committed = succeeded(readSnapshot(succeeded(writeSnapshot(one.snapshot, one.derived))))
	const previous =
		change === "lowering" || change === "gone"
			? relowered(committed.snapshot, change)
			: committed.snapshot
	const [second] = draftChain(
		[{ desc: schemaOf(change, "second"), options: asDrafted, declared: noDeclarations }],
		fromSnapshot(previous)
	)
	const two = defined(second, "the second migration")
	return {
		first: viewDraft(
			one.snapshot,
			one.snapshot,
			one.plan.steps,
			identitiesOf(schemaOf(change, "first"))
		),
		second: viewDraft(
			previous,
			two.snapshot,
			two.plan.steps,
			identitiesOf(schemaOf(change, "second"))
		)
	}
}
