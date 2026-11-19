/** What the property of key-references.test.ts reads: its box's schemas, the foreign keys from a key into a key a law
 * model installs, and the specification's. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { defined } from "#test/support/assert.ts"
import {
	contained,
	counted,
	eq,
	f,
	field,
	fin,
	literal,
	mutable,
	on,
	onWhere,
	ordered,
	pred,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

/**
 * The box's statements, each over a target of its own but `self`, by what decides the foreign keys it implies at its
 * source's keys (laws/model/plan.ts keyReferences):
 *
 * - family: M's one member of each O, counted, its group (o) M's primary key, so its owner axis carries M's key into
 *   O's, and its last axis carries O's key into M's from the owners whose count is above 0;
 * - ordered: L's members of each P, by their index, L keyed by (o, at), which no axis carries whole;
 * - superkey: S into T at (g, i, k), a superkey of T's primary key (g, i);
 * - exact: S into E at E's primary key, its terms in another order than S's key, so its own foreign key is S's key
 *   into E's;
 * - selected target: S into U's facts of kind 1 at U's primary key, judged whole where U is immutable and held by its
 *   foreign key where U is mutable;
 * - selected source: S's facts of kind 2 into Y at Y's primary key;
 * - pred source: S at (g, i, pred(k)) into X at (g, i, k), a superkey of X's primary key, which binds only the facts
 *   whose k is above 0;
 * - part of the key: S at g into V's primary key;
 * - into no key: S at (g, i, k) into W at (g, j, z), a superkey of W's primary key (j), so S's key meets (g, j), no key;
 * - self: S into itself at (g, i, k), so S's key meets itself.
 */
const statements = [
	"family",
	"ordered",
	"superkey",
	"exact",
	"selected target",
	"selected source",
	"pred source",
	"part of the key",
	"into no key",
	"self"
] as const
export type Statement = (typeof statements)[number]

/** How the selected target is held: whole by the rule judge, U immutable, or by its foreign key, U mutable. */
const selections = ["whole", "native"] as const

export interface Case {
	readonly selected: (typeof selections)[number]
}

export const caseGen: Gen<Case> = (s) => ({ selected: s.draw(element(selections)) })

/** The containments of the box, by statement: each one's source and target relation. */
const sides: {
	readonly [S in Exclude<Statement, "family" | "ordered">]: readonly [string, string]
} = {
	superkey: ["S", "T"],
	exact: ["S", "E"],
	"selected target": ["S", "U"],
	"selected source": ["S", "Y"],
	"pred source": ["S", "X"],
	"part of the key": ["S", "V"],
	"into no key": ["S", "W"],
	self: ["S", "S"]
}

/** The case's schema: the box's relations and statements, U mutable where the selected target is held natively. */
export const schemaOf = (c: Case): SchemaDesc => ({
	name: "KeyReferences",
	relations: [
		relation("O", { o: f.bigint, n: f.drawn }, ["o"]),
		relation("M", { o: f.bigint, v: f.bigint }, ["o"]),
		relation("P", { o: f.bigint, n: f.drawn }, ["o"]),
		relation("L", { o: f.bigint, at: f.drawn, v: f.bigint }, ["o", "at"]),
		relation("S", { g: f.bigint, i: f.bigint, k: f.natural }, ["g", "i"]),
		relation("T", { g: f.bigint, i: f.bigint, k: f.natural, x: f.bigint }, ["g", "i"]),
		relation("E", { g: f.bigint, i: f.bigint, y: f.bigint }, ["g", "i"]),
		relation("U", { g: f.bigint, i: f.bigint, k: f.natural }, ["g", "i"]),
		relation("Y", { g: f.bigint, i: f.bigint }, ["g", "i"]),
		relation("X", { g: f.bigint, i: f.bigint, k: f.natural }, ["g", "i"]),
		relation("V", { g: f.bigint }, ["g"]),
		relation("W", { g: f.bigint, j: f.bigint, z: f.natural }, ["j"])
	],
	statements: [
		counted(on("M", ["o"]), fin("O", "n")),
		ordered(on("L", ["o", "at"]), fin("P", "n")),
		contained(on("S", ["g", "i", "k"]), on("T", ["g", "i", "k"])),
		contained(on("S", ["i", "g"]), on("E", ["i", "g"])),
		contained(on("S", ["g", "i"]), onWhere("U", ["g", "i"], eq(field("k"), literal(1n)))),
		contained(onWhere("S", ["g", "i"], eq(field("k"), literal(2n))), on("Y", ["g", "i"])),
		contained(on("S", ["g", "i", pred("k")]), on("X", ["g", "i", "k"])),
		contained(on("S", ["g"]), on("V", ["g"])),
		contained(on("S", ["g", "i", "k"]), on("W", ["g", "j", "z"])),
		contained(on("S", ["g", "i", "k"]), on("S", ["g", "i", "k"])),
		...(c.selected === "native" ? [mutable("U")] : [])
	],
	extends: undefined
})

/** The law of the box's statement `of` in a theory's laws. */
export const lawOf = (laws: ReadonlyArray<TheoryLaw>, of: Statement): TheoryLaw => {
	const found = Arr.filter(laws, (law) => {
		const d = law.detail
		switch (of) {
			case "family":
				return d.kind === "family" && d.family.member.name === "M"
			case "ordered":
				return d.kind === "family" && d.family.member.name === "L"
			case "superkey":
			case "exact":
			case "selected target":
			case "selected source":
			case "pred source":
			case "part of the key":
			case "into no key":
			case "self":
				return (
					d.kind === "containment" &&
					d.from.relation === sides[of][0] &&
					d.to.relation === sides[of][1]
				)
		}
	})
	return defined(found.length === 1 ? found[0] : undefined, `the one law of the box's ${of}`)
}

/**
 * A foreign key from exactly a declared key of its relation, by its fields' names in code point order, into fields of
 * its target, by theirs: the laws it carries in theirs, and whether it is deferred.
 */
export interface KeyReference {
	readonly relation: string
	readonly key: ReadonlyArray<string>
	readonly target: string
	readonly targetKey: ReadonlyArray<string>
	readonly laws: ReadonlyArray<LawId>
	readonly deferrable: boolean
}

/** Whether `fields` are exactly a declared key of `relation`. */
const declaredKey = (relation: LawRelation, fields: ReadonlyArray<string>): boolean =>
	Arr.some(
		relation.keyNames,
		(k) =>
			k.fields.length === fields.length && Arr.every(k.fields, (f) => Arr.contains(fields, f.name))
	)

/** The names of columns that are each a field, in their order; none where one is a law column. */
const fieldsOf = (columns: ReadonlyArray<NativeColumn>): ReadonlyArray<string> | undefined => {
	const names = Arr.flatMap(columns, (c) => (c.kind === "field" ? [c.field.name] : []))
	return names.length === columns.length ? names : undefined
}

/** Every foreign key a law model installs from exactly a declared key of its relation into fields of its target
 * (`KeyReference`), in the model's order. */
export const keyReferencesOf = (model: LawModel): ReadonlyArray<KeyReference> =>
	Arr.flatMap(model.natives, ({ object }): ReadonlyArray<KeyReference> => {
		if (object.kind !== "ForeignKey") {
			return []
		}
		const key = fieldsOf(object.columns)
		const targetKey = fieldsOf(object.targetColumns)
		return key === undefined || targetKey === undefined || !declaredKey(object.relation, key)
			? []
			: [
					{
						relation: object.relation.name,
						key: Arr.sort(key, Order.String),
						target: object.target.name,
						targetKey: Arr.sort(targetKey, Order.String),
						laws: Arr.sort(object.lawIds, Order.String),
						deferrable: object.deferrable
					}
				]
	})

/** A key reference as one line. */
export const referenceText = (r: KeyReference): string =>
	`${r.relation}(${Arr.join(r.key, ", ")}) -> ${r.target}(${Arr.join(r.targetKey, ", ")}) ${r.deferrable ? "deferred" : "immediate"} for ${Arr.join(r.laws, " ")}`

/**
 * The foreign keys from exactly a declared key the box states (the specification): one for each containment from an
 * unselected source whose every column holds a value on every row and which carries a declared key of its source
 * whole into a declared key of its target, its own foreign key where that is the whole containment, carrying its law,
 * and deferred exactly where its law is held only at COMMIT: the family's owner axis M(o) into O(o), immediate, as the
 * axis is, on no cycle of the foreign keys that order a write; the containment into T's superkey at S's key into T's,
 * and the exact one into E, each deferred, its target holding a field it does not reference, which a write may
 * replace; and the one into U's selected facts, deferred whichever way it is held, judged whole at COMMIT or by its
 * foreign key into U's law columns, no field of U. None for the ordered family, whose axes carry no key of L whole, for
 * the last axis, which binds only the owners whose count is above 0, nor for the predecessor axis, which binds only the
 * members after the first; none from S's selected facts, from S at a pred term, from S at a part of its key, into W at
 * (g, j), which no key of W holds apart, nor from S's key into itself.
 */
export const expectedReferences = (laws: ReadonlyArray<TheoryLaw>): ReadonlyArray<KeyReference> => {
	const of = (statement: Statement) => [lawOf(laws, statement).id]
	const keyed = { key: ["g", "i"], targetKey: ["g", "i"], deferrable: true } as const
	return [
		{
			relation: "M",
			key: ["o"],
			target: "O",
			targetKey: ["o"],
			laws: of("family"),
			deferrable: false
		},
		{ relation: "S", target: "T", laws: of("superkey"), ...keyed },
		{ relation: "S", target: "E", laws: of("exact"), ...keyed },
		{ relation: "S", target: "U", laws: of("selected target"), ...keyed }
	]
}
