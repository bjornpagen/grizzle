/** What the properties of reachable.test.ts read: their spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { natural, pg, retirement, sha256 } from "#compiler/public/fields.ts"
import { pred, records, relation, select } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	onBuilder,
	reachableBuilder,
	retirableBuilder
} from "#compiler/schema/statements.ts"
import { admitRole } from "#compiler/schema/world.ts"
import type { RecordsRelation } from "#compiler/types/schema/records.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking, ownInput } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/** The source the records' query reads: items, each with at most one note. */
const Item = relation("Item", { id: pg.integer, v: pg.integer }, ["id"])
const Note = relation("Note", { item: pg.integer, w: pg.integer }, ["item"])
const Source = schema("Source", [Item, Note], [], [])

/** The records' query: every item, its note attached as an option, so the records hold a root and an attachment. */
const itemsQuery = queryOver(Source)
	.rule((r: RuleValue) => {
		const { id, v } = varsOver(Item, "item")
		return r.match(Item, { id, v }).find({ id, v })
	})
	.attach(
		"note",
		(p: Readonly<Record<string, unknown>>) =>
			queryOver(Source).rule((r: RuleValue) => {
				const { w } = varsOver(Note, "note")
				return r.match(Note, { item: p["id"], w }).find({ w })
			}),
		"option"
	)

/**
 * The records the schema door's box declares, keyed by two fields, a digest and a natural part, so a target can name
 * them out of order or a prefix of them, and a holder can read pred of the part.
 */
const Kept = records("Kept", itemsQuery, { digest: sha256, part: natural }, ["digest", "part"])

/** The holder, a body of Root where the case states its unit; and the second statement's holder beside it. */
const Ref = relation("Ref", { root: pg.integer, n: pg.integer, digest: sha256, part: natural }, [
	"root",
	"n"
])
const Ref2 = relation("Ref2", { root: pg.integer, n: pg.integer, digest: sha256, part: natural }, [
	"root",
	"n"
])
const Root = relation("Root", { id: pg.integer, retired: retirement }, ["id"])

/** A unit over its log, whose bodies the records join where the case makes them one. */
const Run = relation("Run", { digest: sha256, part: natural, retired: retirement }, [
	"digest",
	"part"
])
const RunLog = relation("RunLog", { digest: sha256, part: natural, n: pg.integer }, [
	"digest",
	"part",
	"n"
])

/** A relation over the owner key's fields that is no records: a target over it is no records' side. */
const Plain = relation("Plain", { digest: sha256, part: natural }, ["digest", "part"])

/** A relation outside the records over their key, contained into or from their root where the case states it. */
const Ext = relation("Ext", { digest: sha256, part: natural }, ["digest", "part"])

/** One declaration of the schema door's box. */
export interface Declared {
	/** The target: the records at their whole key in order, at it reversed, at a prefix of it, or a plain relation. */
	readonly target: "whole" | "reversed" | "prefix" | "plain"
	/**
	 * The holders: Ref at the key's two fields; Ref selected; Ref at one field; Ref at the digest and pred of the part;
	 * Ref named twice; or none.
	 */
	readonly holder: "fields" | "selected" | "narrow" | "pred" | "twice" | "none"
	/** Whether Ref is a body of Root's unit, beside Ref2. */
	readonly unit: boolean
	/** The records: free, a body of Run's unit beside its log, or the target of a second reachable statement held by Ref2. */
	readonly records: "free" | "body" | "second"
	/** A containment into the records' root: none, from Ext, or the holder's own restated. */
	readonly inward: "none" | "outside" | "restated"
	/** Whether the records' root is contained in Ext, a containment out of the records. */
	readonly outward: boolean
}

export const declaredGen: Gen<Declared> = (source) => ({
	target: source.draw(element<Declared["target"]>(["whole", "reversed", "prefix", "plain"])),
	holder: source.draw(
		element<Declared["holder"]>(["fields", "selected", "narrow", "pred", "twice", "none"])
	),
	unit: source.draw(boolean),
	records: source.draw(element<Declared["records"]>(["free", "body", "second"])),
	inward: source.draw(element<Declared["inward"]>(["none", "outside", "restated"])),
	outward: source.draw(boolean)
})

/** A rule the builder reachable(...) holds, which a declaration breaks. */
type BuilderRule =
	| "the target is no records' side"
	| "a holder is selected"
	| "a holder's width is not the target's"
	| "a holder is named twice"
	| "no holder"

/** A rule ownership holds a reachable statement to, which a declaration breaks. */
type OwnedRule =
	| "the target is not the records' whole key in order"
	| "a holder reads a pred term"
	| "a holder is no retirable body"
	| "the records are a retirable body"
	| "the records are a second statement's target"
	| "a containment into the records comes from outside them"

/** The refusal each builder rule names (core/refusals.ts). */
const builderRefusals = {
	"the target is no records' side":
		"a reachable target is a side over records, on(records, …their owner's key fields)",
	"a holder is selected": "a holder is every fact of its relation",
	"a holder's width is not the target's": "a holder's fields do not match the records' owner key",
	"a holder is named twice": "a reachable statement names each holder once",
	"no holder": "a reachable statement is held by at least one holder relation"
} as const satisfies Readonly<Record<BuilderRule, string>>

/** The width of a declaration's target, its count of terms. */
const targetWidth = (d: Declared): number => (d.target === "prefix" ? 1 : 2)

/** The width of each of a declaration's holders. */
const holderWidth = (d: Declared): number => (d.holder === "narrow" ? 1 : 2)

/** The builder rules `d` breaks, by the statement's documentation restated over the box. */
export const builderBrokenOf = (d: Declared): ReadonlyArray<BuilderRule> => [
	...(d.target === "plain" ? ["the target is no records' side" as const] : []),
	...(d.holder === "selected" ? ["a holder is selected" as const] : []),
	...(d.holder !== "none" && holderWidth(d) !== targetWidth(d)
		? ["a holder's width is not the target's" as const]
		: []),
	...(d.holder === "twice" ? ["a holder is named twice" as const] : []),
	...(d.holder === "none" ? ["no holder" as const] : [])
]

/** The ownership rules `d` breaks, by the statement's documentation restated over the box. */
export const ownedBrokenOf = (d: Declared): ReadonlyArray<OwnedRule> => [
	...(d.target === "reversed" || d.target === "prefix"
		? ["the target is not the records' whole key in order" as const]
		: []),
	...(d.holder === "pred" ? ["a holder reads a pred term" as const] : []),
	...(!d.unit && d.holder !== "none" ? ["a holder is no retirable body" as const] : []),
	...(d.records === "body" ? ["the records are a retirable body" as const] : []),
	...(d.records === "second" ? ["the records are a second statement's target" as const] : []),
	...(d.inward === "none"
		? []
		: ["a containment into the records comes from outside them" as const])
]

/** The target side of `d`. */
const targetOf = (d: Declared): unknown => {
	switch (d.target) {
		case "whole":
			return onBuilder(Kept, ["digest", "part"])
		case "reversed":
			return onBuilder(Kept, ["part", "digest"])
		case "prefix":
			return onBuilder(Kept, ["digest"])
		case "plain":
			return onBuilder(Plain, ["digest", "part"])
	}
}

/** The holder sides of `d`. */
const holdersOf = (d: Declared): ReadonlyArray<unknown> => {
	switch (d.holder) {
		case "fields":
			return [onBuilder(Ref, ["digest", "part"])]
		case "selected":
			return [
				onBuilder(
					select(Ref, (x) => x.eq(x.n, 0)),
					["digest", "part"]
				)
			]
		case "narrow":
			return [onBuilder(Ref, ["digest"])]
		case "pred":
			return [onBuilder(Ref, ["digest", pred("part")])]
		case "twice":
			return [onBuilder(Ref, ["digest", "part"]), onBuilder(Ref, ["digest", "part"])]
		case "none":
			return []
	}
}

/**
 * The schema `d` declares, built through the builders: Source's relations, the records', Root's unit over Ref2 and over
 * Ref where `unit`, Run's over its log and over the records where they are its body, Plain and Ext; the records' own
 * laws, the reachable statement, the second one over Ref2 where the case states it, and the containments it states. A
 * builder's refusal is thrown.
 */
const declared = (d: Declared): unknown => {
	const statement = reachableBuilder(targetOf(d), holdersOf(d))
	const keptKey = onBuilder(Kept.row, ["digest", "part"])
	const relations: ReadonlyArray<AnyRelation> = [
		Item,
		Note,
		...Kept.relations,
		Root,
		Ref,
		Ref2,
		Run,
		RunLog,
		Plain,
		Ext
	]
	const statements: ReadonlyArray<Statement> = [
		...Kept.rules,
		statement,
		retirableBuilder(Root, [
			...(d.unit ? [onBuilder(Ref, ["root"])] : []),
			onBuilder(Ref2, ["root"])
		]),
		retirableBuilder(Run, [
			onBuilder(RunLog, ["digest", "part"]),
			...(d.records === "body" ? [onBuilder(Kept, ["digest", "part"])] : [])
		]),
		...(d.records === "second"
			? [
					reachableBuilder(onBuilder(Kept, ["digest", "part"]), [
						onBuilder(Ref2, ["digest", "part"])
					])
				]
			: []),
		...(d.inward === "outside"
			? [containedBuilder(onBuilder(Ext, ["digest", "part"]), keptKey)]
			: d.inward === "restated"
				? [containedBuilder(onBuilder(Ref, ["digest", "part"]), keptKey)]
				: []),
		...(d.outward ? [containedBuilder(keptKey, onBuilder(Ext, ["digest", "part"]))] : [])
	]
	return schema("Reach", relations, statements, [])
}

/** How the schema door answers `d`: owned, or refused with the CompileError the builders threw or ownership returned. */
export const answerOf = (d: Declared) =>
	Result.flatMap(
		catchCompileError(() => declared(d)),
		(built) => Result.flatMap(parseSchemaInput(built), ownInput)
	)

/** The refusals a builder rule broken alone or beside others may be thrown as: each broken rule's. */
export const refusalsOf = (broken: ReadonlyArray<BuilderRule>): ReadonlyArray<string> =>
	Arr.map(broken, (rule) => builderRefusals[rule])

export type DoorFeature =
	| "owned"
	| "owned: a containment out of the records"
	| `refused: ${BuilderRule}`
	| `refused: ${OwnedRule}`

/** The records of the role and ChangeSet doors' schema, keyed by their digest alone, as den's are. */
const Held = records("Held", itemsQuery, { digest: sha256 }, ["digest"])

const Batch = relation("Batch", { id: pg.integer, retired: retirement }, ["id"])
const Other = relation("Other", { id: pg.integer, retired: retirement }, ["id"])
const Mark = relation("Mark", { root: pg.integer, n: pg.integer, digest: sha256 }, ["root", "n"])
const Cite = relation("Cite", { by: pg.integer, digest: sha256 }, ["by", "digest"])
const Log = relation("Log", { other: pg.integer, n: pg.integer }, ["other", "n"])
const Out = relation("Out", { digest: sha256, v: pg.integer }, ["digest"])

/**
 * The schema of the role and ChangeSet doors: Source's relations, the records, Root's unit over Mark, Batch's over Cite,
 * Other's over Log, holding no records, and Out beside them; the records reachable from Mark and Cite.
 */
const Reach = schema(
	"Reach",
	[Item, Note, ...Held.relations, Root, Mark, Batch, Cite, Other, Log, Out],
	[
		...Held.rules,
		retirableBuilder(Root, [onBuilder(Mark, ["root"])]),
		retirableBuilder(Batch, [onBuilder(Cite, ["by"])]),
		retirableBuilder(Other, [onBuilder(Log, ["other"])]),
		reachableBuilder(onBuilder(Held, ["digest"]), [
			onBuilder(Mark, ["digest"]),
			onBuilder(Cite, ["digest"])
		])
	],
	[]
)

/** The relations a role's list is drawn from: the two holders, and Out, which holds nothing. */
const listedNames = ["Mark", "Cite", "Out"] as const

type Listed = (typeof listedNames)[number]

/** Every nonempty set of the listed relations, in their order. */
const listedSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Listed>> = [
	["Mark"],
	["Cite"],
	["Out"],
	["Mark", "Cite"],
	["Mark", "Out"],
	["Cite", "Out"],
	["Mark", "Cite", "Out"]
]

/** A role of the box: whether its list writes or only inserts, and the relations it names. */
export interface RoleDeclared {
	readonly list: "write" | "insert"
	readonly names: Arr.NonEmptyReadonlyArray<Listed>
}

export const roleGen: Gen<RoleDeclared> = (source) => ({
	list: source.draw(element<RoleDeclared["list"]>(["write", "insert"])),
	names: source.draw(element(listedSets))
})

/** The holders a role's list names, which a write list may not: Mark and Cite. */
export const holdersNamed = (r: RoleDeclared): ReadonlyArray<string> =>
	Arr.filter(r.names, (n) => n !== "Out")

/**
 * The role `r` declares over Reach, its every relation whole, through the role builder's admission core and owned over
 * its base, as a compile owns a role (schema/own.ts ownRole).
 */
export const roleAnswerOf = (r: RoleDeclared) =>
	Result.flatMap(
		catchCompileError(() =>
			admitRole(
				Reach,
				"keeper",
				Object.freeze({ Item, Note, Root, Mark, Batch, Cite, Other, Log, Out }),
				r.list === "write" ? { write: r.names } : { insert: r.names },
				[]
			)
		),
		(admitted) => ownRole(admitted.desc)
	)

export type RoleFeature =
	| "refused: a write list names a holder"
	| "owned: a write list names no holder"
	| "owned: an insert list names a holder"

/** The unit a drawn ChangeSet retires: a holder's, Root's or Batch's; Other's, which holds no records; or none. */
export type Retired = "Root" | "Batch" | "Other" | "none"

/**
 * How a drawn ChangeSet touches the records beside its retirement: it inserts their root, or their note attachment;
 * inserts Out from a query of their root, a read; reads back their root's added delta; or inserts Out alone, no touch.
 */
export type Touch = "rootWritten" | "noteWritten" | "rootRead" | "rootDelta" | "outWritten"

export interface ChangeDeclared {
	readonly retired: Retired
	readonly touch: Touch
}

export const changeGen: Gen<ChangeDeclared> = (source) => ({
	retired: source.draw(element<Retired>(["Root", "Batch", "Other", "none"])),
	touch: source.draw(
		element<Touch>(["rootWritten", "noteWritten", "rootRead", "rootDelta", "outWritten"])
	)
})

/** The header of each retired unit. */
const headers = { Root, Batch, Other } as const

/** The note attachment's relation of the records: their one relation but the root. */
const heldNote: RecordsRelation = defined(
	Option.getOrUndefined(Arr.findFirst(Held.relations, (r) => r !== Held.row)),
	"the records of items hold their note's relation"
)

/** Out's rows from the records' root: a read of it. */
const rootRead = queryOver(Reach).rule((r: RuleValue) => {
	const { digest, id, v } = varsOver(Held.row, "held")
	return r.match(Held.row, { digest, id, v }).find({ digest, v })
})

/** The read-back of the records' root's added delta. */
const rootDelta = (d: DeltaValue): unknown =>
	queryOver(Reach).rule((r: RuleValue) => {
		const { digest, id, v } = varsOver(Held.row, "held")
		return r.match(d.added(Held.row), { digest, id, v }).find({ digest })
	})

/** The drawn ChangeSet over Reach: its retirement, then its touch, in one stratum. */
const changeOf = (d: ChangeDeclared): ChangeSetValue => {
	const retiring =
		d.retired === "none"
			? ChangeSet.empty(Reach)
			: ChangeSet.empty(Reach).retire(headers[d.retired], [])
	switch (d.touch) {
		case "rootWritten":
			return retiring.insert(Held.row, [])
		case "noteWritten":
			return retiring.insert(heldNote, [])
		case "rootRead":
			return retiring.insert(Out, rootRead)
		case "rootDelta":
			return retiring.insert(Out, []).read("r", rootDelta)
		case "outWritten":
			return retiring.insert(Out, [])
	}
}

/** What a ChangeSet over Reach compiles against: the schema's reality. */
const reality = (() => ({
	checked: checking(Reach),
	options: realityWrite(succeeded(testArtifacts(Reach, testCompile)))
}))()

/** The drawn ChangeSet compiled over Reach's reality. */
export const changeAnswerOf = (d: ChangeDeclared) =>
	compileWrite(reality.checked, descOf(changeOf(d)), reality.options)

/** The relation of the records a touch names and how, as RetiredUnitTouched names it; none for a touch of Out alone. */
export const touchedOf = (
	t: Touch
): { readonly relation: string; readonly how: "written" | "read" | "delta" } | undefined => {
	switch (t) {
		case "rootWritten":
			return { relation: Held.row.name, how: "written" }
		case "noteWritten":
			return { relation: heldNote.name, how: "written" }
		case "rootRead":
			return { relation: Held.row.name, how: "read" }
		case "rootDelta":
			return { relation: Held.row.name, how: "delta" }
		case "outWritten":
			return undefined
	}
}

export type ChangeFeature =
	| "refused: a write of the records' root"
	| "refused: a write of the records' attachment"
	| "refused: a read of the records"
	| "refused: a delta of the records"
	| "refused: beside Batch's retirement"
	| "compiled: a touch of the records beside Other's retirement"
	| "compiled: a touch of the records retiring nothing"
