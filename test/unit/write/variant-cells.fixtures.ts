/** What variant-cells.test.ts reads: the typed form and the cell form of QTI's values, and each write's statement bytes. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { closedId, generated, natural, pg, sha256, variant } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyRelation,
	closed,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** QTI's base types, an unordered roster: the variant's tag. */
const BaseType = closed.unordered("BaseType", [
	"boolean",
	"directedPair",
	"duration",
	"file",
	"float",
	"identifier",
	"integer",
	"pair",
	"point",
	"string",
	"uri"
])

/** A QTI identifier, and a text of a variable's value, each held by a B-tree key. */
const Identifier = str.bytes(64, str.regex("^[A-Za-z_][A-Za-z0-9_.-]*$"))
const Text = str.bytes(256, str.regex("^.*$", "su"))

/** Each base type's fields, as the ledger's leaf states them. */
const leaf = {
	boolean: { value: pg.boolean },
	directedPair: { source: Identifier, target: Identifier },
	duration: { value: pg["double precision"] },
	file: { digest: sha256, name: Text, type: Text },
	float: { value: pg["double precision"] },
	identifier: { value: Identifier },
	integer: { value: pg.integer },
	pair: { greatest: Identifier, least: Identifier },
	point: { x: pg.integer, y: pg.integer },
	string: { value: Text },
	uri: { value: Text }
} as const

/** A cardinality of a QTI variable, with a record's fields: one table of each in the cell form, eleven in the typed. */
export type Cardinality = "single" | "multiple" | "ordered" | "record"

export const cardinalities: Gen<Cardinality> = element<Cardinality>([
	"single",
	"multiple",
	"ordered",
	"record"
])

/** Each base type's fields as the typed form reads them: a record of descriptors by field name. */
const typedLeaf: Readonly<Record<string, Readonly<Record<string, FieldBase>>>> = leaf

/** A multiple's fields: its variable, its value's fields and how many times the value occurs. */
const withCount = (
	fields: Readonly<Record<string, FieldBase>>
): Readonly<Record<string, FieldBase>> => ({ variable: Identifier, ...fields, count: natural })

/** The typed form's table of `cardinality` and base type `base`: the base type's fields beside its key's. */
const typedTable = (cardinality: Cardinality, base: string) => {
	const fields = typedLeaf[base] ?? {}
	const name = `${cardinality}_${base}`
	switch (cardinality) {
		case "single":
			return relationBuilder(name, { variable: Identifier, ...fields }, ["variable"], [])
		case "multiple":
			return relationBuilder(name, withCount(fields), ["variable", ...Rec.keys(fields)], [])
		case "ordered":
			return relationBuilder(
				name,
				{ variable: Identifier, place: natural, ...fields },
				["variable", "place"],
				[]
			)
		case "record":
			return relationBuilder(
				name,
				{ variable: Identifier, field: Identifier, ...fields },
				["variable", "field"],
				[]
			)
	}
}

/** The cell: one value of any base type (README "Variants"). */
const QtiValue = variant("QtiValue", BaseType, leaf, { pair: (a) => a.le(a.least, a.greatest) })

/** The cell form's table of `cardinality`: its key's fields and one cell, its tag a generated closed id. */
const cellTable = (cardinality: Cardinality) => {
	switch (cardinality) {
		case "single":
			return relation.generated(
				"single",
				{ variable: Identifier, value: QtiValue },
				["variable"],
				(r) => ({
					baseType: generated(closedId(BaseType), QtiValue.tag(r.value))
				})
			)
		case "multiple":
			return relation.generated(
				"multiple",
				{ variable: Identifier, value: QtiValue, count: natural },
				["variable", "image"],
				(r) => ({
					baseType: generated(closedId(BaseType), QtiValue.tag(r.value)),
					image: generated(sha256, QtiValue.digest(r.value))
				})
			)
		case "ordered":
			return relation.generated(
				"ordered",
				{ variable: Identifier, place: natural, value: QtiValue },
				["variable", "place"],
				(r) => ({ baseType: generated(closedId(BaseType), QtiValue.tag(r.value)) })
			)
		case "record":
			return relation.generated(
				"record",
				{ variable: Identifier, field: Identifier, value: QtiValue },
				["variable", "field"],
				(r) => ({ baseType: generated(closedId(BaseType), QtiValue.tag(r.value)) })
			)
	}
}

/** The UTF-8 bytes of every statement a write of `relations` sends, each relation inserted from its facts. */
const writeBytes = (
	name: string,
	relations: ReadonlyArray<AnyRelation>,
	rosters: ReadonlyArray<AnyClosed>
): number => {
	const values = schema(name, [...rosters, ...relations], [])
	const write = Arr.reduce(relations, ChangeSet.empty(values), (cs, r) => cs.insert(r, []))
	const compiled = succeeded(
		compileWrite(
			checking(values),
			descOf(write),
			realityWrite(succeeded(testArtifacts(values, testCompile)))
		),
		`the write of ${name} compiles`
	)
	return Arr.reduce(
		compiled.artifact.statements,
		0,
		(n, s) => n + new TextEncoder().encode(s.spec.sql).length
	)
}

/**
 * The scalar twin of the cell table of `cardinality`: its heading with its cell one closed id of the base types, the
 * generated tag read from it, and a multiple's image a caller's digest, where the cell's is its key generation. Its
 * write's statement is the frame a write of the heading prints and each of its fields' prints as a scalar's: the bound
 * the cell's write is held to, since a cell is one column and prints as one wherever its write names it.
 */
const twinTable = (cardinality: Cardinality) => {
	const value = closedId(BaseType)
	switch (cardinality) {
		case "single":
			return relation.generated("single", { variable: Identifier, value }, ["variable"], (r) => ({
				baseType: generated(closedId(BaseType), r.value)
			}))
		case "multiple":
			return relation.generated(
				"multiple",
				{ variable: Identifier, value, count: natural, image: sha256 },
				["variable", "image"],
				(r) => ({ baseType: generated(closedId(BaseType), r.value) })
			)
		case "ordered":
			return relation.generated(
				"ordered",
				{ variable: Identifier, place: natural, value },
				["variable", "place"],
				(r) => ({ baseType: generated(closedId(BaseType), r.value) })
			)
		case "record":
			return relation.generated(
				"record",
				{ variable: Identifier, field: Identifier, value },
				["variable", "field"],
				(r) => ({ baseType: generated(closedId(BaseType), r.value) })
			)
	}
}

/**
 * The statement bytes of a write of the cell table of `cardinality`, of its scalar twin (twinTable), and of the typed
 * form's eleven tables of it, the fan-out the cell replaces.
 */
export const bytesOf = (
	cardinality: Cardinality
): { readonly cell: number; readonly twin: number; readonly typed: number } => ({
	cell: writeBytes("Cell", [cellTable(cardinality)], [BaseType]),
	twin: writeBytes("Twin", [twinTable(cardinality)], [BaseType]),
	typed: writeBytes(
		"Typed",
		Arr.map(Rec.keys(typedLeaf), (base) => typedTable(cardinality, base)),
		[]
	)
})
