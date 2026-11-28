/** What the properties of unwritten-read-backs.test.ts read: its spaces, models and helpers. */

import { element, type Gen, shuffled, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	login,
	on,
	relation,
	role,
	type Schema,
	schema,
	type StatementsByName,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { generatedTemplate } from "#test/support/install-migrate.ts"
import { rebuild } from "#test/support/installed.ts"
import type { FactSet } from "#test/support/oracle/install/load.ts"

const Label = str.regex("^[a-z]{1,4}$")

/** A parent, its one shelf, which it is contained in, its label, an option, and its badge, another. */
const Shelf = relation("Shelf", { id: int4 }, ["id"])
const Parent = relation("Parent", { id: int4, shelf: int4 }, ["id"])
const Tag = relation("Tag", { parent: int4, label: Label }, ["parent"])
const Badge = relation("Badge", { parent: int4, label: Label }, ["parent"])

export const Family = schema(
	"Family",
	[Shelf, Parent, Tag, Badge],
	[contained(on(Parent, "shelf"), on(Shelf, "id"))]
)

/** Family under another name, as an installation under a unique schema name opens it. */
type FamilyNamed<N extends string> = Schema<
	N,
	(typeof Family)["relations"],
	StatementsByName<(typeof Family)["statements"], (typeof Family)["relations"]>
>

/**
 * Every parent with its shelf, a bare child, which the containment proves exactly one of, and its tag and badge, each
 * an option, which Tag's and Badge's keys on the parent prove at most one of: a read-back checks each of those delivered
 * types in its own statement, through the installation's refusal function (lower/conservative/deliver.ts
 * checkedAttachment).
 */
const familyOf = (installed: FamilyNamed<string>) =>
	query(installed)
		.rule((r) => {
			const { id, shelf } = v(Parent, "parent")
			return r.match(Parent, { id, shelf }).find({ id, shelf })
		})
		.attach(
			"onShelf",
			(p) => query(installed).rule((r) => r.match(Shelf, { id: p.shelf }).find({ shelved: true })),
			"one"
		)
		.attach(
			"tag",
			(p) =>
				query(installed).rule((r) => {
					const { label } = v(Tag, "tag")
					return r.match(Tag, { parent: p.id, label }).find({ label })
				}),
			"option"
		)
		.attach(
			"badge",
			(p) =>
				query(installed).rule((r) => {
					const { label } = v(Badge, "badge")
					return r.match(Badge, { parent: p.id, label }).find({ label })
				}),
			"option"
		)

/**
 * The reader's login over the schema it is given: one role holding every relation whole and writing none, whose one
 * member is the family read back by a ChangeSet that writes nothing, as Learning Commons' reader reads (edullm
 * packages/data/learning-commons logins.ts).
 */
export const readerApp = (installed: FamilyNamed<string>) => {
	const reader = role(installed, "reader", wholeEntriesOf(installed))
	return login(installed, "reader_app", [reader], {
		workload: [
			workload(reader, {
				family: ChangeSet.empty(installed).read("family", () => familyOf(installed))
			})
		]
	})
}

/** Family drafted and served as `grizzle generate` does, with the reader's login, which Served.of serves per case. */
export const familyTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "family read back by a reader",
	content: { schema: "Family", logins: ["reader_app, reading the family back by a ChangeSet"] },
	build: (name) => {
		const named = rebuild(Family, name)
		return { schema: named, logins: [readerApp(named)] }
	},
	ambient: ordinarySession
})

const labels = ["a", "bc", "def"] as const

/** A parent as a case states it: its id, its tag's label and its badge's, each none for no row. */
interface ParentCase {
	readonly id: number
	readonly tag: Option.Option<string>
	readonly badge: Option.Option<string>
}

/** A case: the parents stored, each on the one shelf, and the labels of tags and badges stored for no parent. */
export interface FamilyCase {
	readonly parents: ReadonlyArray<ParentCase>
	readonly strays: ReadonlyArray<number>
}

export type Feature =
	| "no parent"
	| "a parent with a tag and a badge"
	| "a parent with neither"
	| "a parent with one of them"
	| "a tag of no parent"

const labelGen: Gen<Option.Option<string>> = (source) => {
	const label = source.draw(element([...labels, "none"] as const))
	return label === "none" ? Option.none() : Option.some(label)
}

const ids: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 6)

export const caseGen: Gen<FamilyCase> = (source) => ({
	parents: Arr.map(source.draw(shuffled(ids, { min: 0, max: 3 })), (id) => ({
		id,
		tag: source.draw(labelGen),
		badge: source.draw(labelGen)
	})),
	strays: Arr.map(source.draw(subarray([7, 8] as const)), (id) => id)
})

/** The features a case reaches. */
export const featuresOf = (c: FamilyCase): ReadonlyArray<Feature> => [
	...(c.parents.length === 0 ? (["no parent"] as const) : []),
	...Arr.map(c.parents, (p): Feature => {
		const held = Arr.filter([p.tag, p.badge], Option.isSome).length
		return held === 2
			? "a parent with a tag and a badge"
			: held === 0
				? "a parent with neither"
				: "a parent with one of them"
	}),
	...(c.strays.length > 0 ? (["a tag of no parent"] as const) : [])
]

/** The rows a case stores: one shelf, its parents on it, their tags and badges, and a tag for each stray id. */
export const factsOf = (c: FamilyCase): FactSet => ({
	Shelf: [{ id: 1 }],
	Parent: Arr.map(c.parents, (p) => ({ id: p.id, shelf: 1 })),
	Tag: [
		...Arr.flatMap(c.parents, (p) =>
			Option.match(p.tag, {
				onNone: () => [],
				onSome: (label) => [{ parent: p.id, label }]
			})
		),
		...Arr.map(c.strays, (parent) => ({ parent, label: "a" }))
	],
	Badge: Arr.flatMap(c.parents, (p) =>
		Option.match(p.badge, {
			onNone: () => [],
			onSome: (label) => [{ parent: p.id, label }]
		})
	)
})

/** A delivered row as the model states it: the parent's id, and its tag's and badge's label, none for no child. */
interface Delivered {
	readonly id: number
	readonly tag: string | undefined
	readonly badge: string | undefined
}

/** What the read-back delivers over a case: every parent, on its shelf, with its tag and badge where it has them. */
export const modelOf = (c: FamilyCase): ReadonlyArray<Delivered> =>
	Arr.map(c.parents, (p) => ({
		id: p.id,
		tag: Option.getOrUndefined(p.tag),
		badge: Option.getOrUndefined(p.badge)
	}))

/** The child row a delivered attachment holds, none for none: the decoded row holds each as an Option of its row. */
const childOf = (value: unknown): Option.Option<unknown> =>
	Option.isOption(value) ? value : Option.some(value)

/** The label of a delivered option, none for none, and "malformed" for a child that holds no label. */
const labelOf = (value: unknown): string | undefined =>
	Option.match(childOf(value), {
		onNone: () => undefined,
		onSome: (child) =>
			isRecord(child) && typeof child["label"] === "string" ? child["label"] : "malformed"
	})

/**
 * A delivered row read as the model states it: its id, its tag's and badge's label; a row that delivers no shelf, or
 * a shelf that is no `{ shelved: true }`, reads as id 0, which no model row holds.
 */
export const deliveredOf = (row: unknown): Delivered => {
	const shelf = isRecord(row) ? childOf(row["onShelf"]) : Option.none()
	const shelved = Option.exists(shelf, (child) => isRecord(child) && child["shelved"] === true)
	return {
		id: isRecord(row) && typeof row["id"] === "number" && shelved ? row["id"] : 0,
		tag: isRecord(row) ? labelOf(row["tag"]) : "malformed",
		badge: isRecord(row) ? labelOf(row["badge"]) : "malformed"
	}
}
