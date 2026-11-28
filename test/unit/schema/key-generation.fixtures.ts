/** What the property of key-generation.test.ts reads: its four templates, its space, and each case's two schemas. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { element, type Gen, subset, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Result as EffectResult } from "effect"
import { type CompileError, isCompileError } from "#compiler/core/errors.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { instant, natural, place, int4 } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	accumulatedField,
	drawnField,
	generatedField,
	generatedRelation,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	finBuilder,
	foldBuilder,
	keyBuilder,
	monoids,
	onBuilder,
	orderedBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase, GeneratedField } from "#compiler/types/fields/field.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { Id } from "#test/support/ids.ts"
import { ownInput } from "#test/support/policy.ts"

/**
 * How a field of a template's relation is written (ir/desc.ts Writing): by its caller, drawn by grizzle from the
 * nesting, accumulated along a family's axis, or stamped as a place in its group.
 */
export type Writing = "caller" | "drawn" | "accumulated" | "place"

/**
 * What a field's value is, so the generation can read it: a text it reads as itself, an integer (int4), a natural
 * (a drawn field's or a place's type, whose literals are bigints).
 */
type Form = "text" | "integer" | "natural"

/** A field the generation may read: its name, how it is written, and its form. */
export interface Readable {
	readonly field: string
	readonly writing: Writing
	readonly form: Form
}

/** Where a case puts the generated field `g`: in its relation's primary key, or outside it beside a key of `name`. */
export type Placement = "key" | "control"

/** The relations and statements a template declares, its generated field's relation keyed by `key`. */
interface Declared {
	readonly relations: ReadonlyArray<AnyRelation>
	readonly statements: ReadonlyArray<Statement>
}

/**
 * A template: a relation `R`, built by relation.generated, whose fields are written in the ways `readables` names, and
 * the statements that make each such field lawful (a family that draws, a fold that accumulates, a place's group). `declare` builds it over the primary key `slot` completes: `slot` is `g`, the generated field, or
 * `name`, a bounded caller text, and the generated field reads `reads`.
 */
interface Template {
	readonly readables: Arr.NonEmptyReadonlyArray<Readable>
	readonly declare: (slot: "g" | "name", generation: Generation) => Declared
}

/** The generated field's builder: over the row relation.generated hands its callback, the field `g`. */
type Generation = (
	row: Readonly<Record<string, unknown>>
) => Readonly<Record<"g", GeneratedField<FieldBase>>>

/**
 * Relation `name` of the written fields `fields` and the generated field `g`, keyed by `primaryKey`. Its fields are
 * typed as a record of any names, as a relation drawn at run time is, so its key may name `g` or a written field alike.
 */
const keyedRelation = (
	name: string,
	fields: Readonly<Record<string, FieldBase>>,
	primaryKey: ReadonlyArray<string>,
	generation: Generation
): AnyRelation => generatedRelation(name, fields, primaryKey, generation, [])

/** A piece of text a fold concatenates: at most sixteen bytes, any characters. */
const Piece = str.bytes(16, str.regex("^.*$", "su"))

/** A bounded caller text a key may hold: at most sixty-four bytes, any characters. */
const Name = str.bytes(64, str.regex("^.*$", "su"))

/** An unbounded caller text, as a document's path is: no key may hold it, only a generation over it. */
const Body = str.regex("^.*$", "su")

/**
 * The generated field's declared type: a bounded text the key's index holds, whose domain checks the generation's
 * value against its bound on every write (check/generated.ts typeRule: a generation is of its column's type but for
 * the pattern and byte bound).
 */
const Generated = str.bytes(256, str.regex("^.*$", "su"))

const caller = (field: string, form: Form): Readable => ({ field, writing: "caller", form })

/**
 * An ordered family: Doc's lines in order, each at its drawn slot, and the concat fold of their pieces into Doc.total,
 * each line's running texts accumulated before and after it. Line's primary key is (doc, slot).
 */
const ordered: Template = {
	readables: [
		caller("name", "text"),
		caller("body", "text"),
		caller("piece", "text"),
		caller("k", "integer"),
		{ field: "at", writing: "drawn", form: "natural" },
		{ field: "before", writing: "accumulated", form: "text" },
		{ field: "after", writing: "accumulated", form: "text" }
	],
	declare: (slot, generation) => {
		const Doc = relation(
			"Doc",
			{ id: Id, n: drawnField(natural, []), total: accumulatedField(Piece, "", []) },
			["id"],
			[]
		)
		const Line = keyedRelation(
			"Line",
			{
				doc: Id,
				at: drawnField(natural, []),
				piece: Piece,
				before: accumulatedField(Piece, "", []),
				after: accumulatedField(Piece, "", []),
				name: Name,
				body: Body,
				k: int4
			},
			["doc", slot],
			generation
		)
		const lines = orderedBuilder(onBuilder(Line, ["doc", "at"]), finBuilder(Doc, "n"))
		return {
			relations: [Doc, Line],
			statements: [
				lines,
				foldBuilder(
					lines,
					monoids.concat,
					onBuilder(Line, ["doc", "piece", "before", "after"]),
					onBuilder(Doc, ["id", "total"])
				)
			]
		}
	}
}

/**
 * A tree, as pantry's Node is: each node keyed by its root fields, the primary key but `start`, and its drawn start,
 * its parent, slot, count and end drawn from the nesting, and the concat fold of the pieces along it. The generation
 * reads no `piece`, which each node states for the fold: a root field's reads are its tree's, stated alike on every
 * node.
 */
const tree: Template = {
	readables: [
		caller("name", "text"),
		caller("body", "text"),
		caller("k", "integer"),
		{ field: "parent", writing: "drawn", form: "natural" },
		{ field: "at", writing: "drawn", form: "natural" },
		{ field: "children", writing: "drawn", form: "natural" },
		{ field: "start", writing: "drawn", form: "natural" },
		{ field: "end", writing: "drawn", form: "natural" },
		{ field: "before", writing: "accumulated", form: "text" },
		{ field: "after", writing: "accumulated", form: "text" },
		{ field: "total", writing: "accumulated", form: "text" }
	],
	declare: (slot, generation) => {
		const Node = keyedRelation(
			"Node",
			{
				doc: Id,
				parent: drawnField(natural, []),
				at: drawnField(natural, []),
				children: drawnField(natural, []),
				start: drawnField(natural, []),
				end: drawnField(natural, []),
				piece: Piece,
				before: accumulatedField(Piece, "", []),
				after: accumulatedField(Piece, "", []),
				total: accumulatedField(Piece, "", []),
				name: Name,
				body: Body,
				k: int4
			},
			["doc", slot, "start"],
			generation
		)
		const nodes = treeBuilder(onBuilder(Node, ["parent", "at"]), finBuilder(Node, "children"), {
			root: ["doc", slot]
		})
		return {
			relations: [Node],
			statements: [
				nodes,
				foldBuilder(
					nodes,
					monoids.concat,
					onBuilder(Node, ["doc", slot, "parent", "piece", "before", "after"]),
					onBuilder(Node, ["doc", slot, "start", "total"])
				)
			]
		}
	}
}

/**
 * A place: each mark at its place within its group, the primary key's fields before the place, its last (`child` and the
 * slot), which the insert that adds it stamps, and a key over its child and `x`, as places.fixtures.ts's Mark has.
 */
const placed: Template = {
	readables: [
		caller("name", "text"),
		caller("body", "text"),
		caller("child", "integer"),
		caller("x", "integer"),
		{ field: "n", writing: "place", form: "natural" }
	],
	declare: (slot, generation) => {
		const Mark = keyedRelation(
			"Mark",
			{ child: int4, n: place, x: int4, name: Name, body: Body },
			["child", slot, "n"],
			generation
		)
		return { relations: [Mark], statements: [keyBuilder(onBuilder(Mark, ["child", "x"]))] }
	}
}

const templateNames = ["ordered", "tree", "placed"] as const

export type TemplateName = (typeof templateNames)[number]

const templates: Readonly<Record<TemplateName, Template>> = { ordered, tree, placed }

/** One case: a template, the fields its generation reads, in the template's order, and where the generation stands. */
export interface KeyGenerationCase {
	readonly template: TemplateName
	readonly reads: Arr.NonEmptyReadonlyArray<Readable>
}

/**
 * The fields a generation reads: a nonempty subset of the template's, drawn half the time among its caller fields
 * alone, so admitted and refused generations are both common however few of its fields its caller writes.
 */
const readsGen = (t: Template): Gen<Arr.NonEmptyReadonlyArray<Readable>> => {
	const callers = Arr.filter(t.readables, (r) => r.writing === "caller")
	const nonEmpty =
		(pool: ReadonlyArray<Readable>): Gen<Arr.NonEmptyReadonlyArray<Readable>> =>
		(source) => {
			const drawn = source.draw(subset(pool, { min: 1, max: pool.length }))
			return Arr.isReadonlyArrayNonEmpty(drawn) ? drawn : t.readables
		}
	return weighted([
		[1, nonEmpty(callers)],
		[1, nonEmpty(t.readables)]
	])
}

export const keyGenerationGen: Gen<KeyGenerationCase> = (source) => {
	const template = source.draw(element(templateNames))
	return { template, reads: source.draw(readsGen(templates[template])) }
}

/** A literal of Piece, which a field that is no text enters the generation as. */
const pieceLiteral = (text: string): unknown => computeCore.literal(Piece, text)

/**
 * A field's value as a text the generation concatenates: a text as itself; an integer or a natural as whether it is
 * positive, a conditional between two literal pieces, which reads the field as every term does.
 */
const formOf = (row: Readonly<Record<string, unknown>>, r: Readable): unknown => {
	const value = row[r.field]
	switch (r.form) {
		case "text":
			return value
		case "integer":
			return computeCore.cond(computeCore.gt(value, 0), pieceLiteral("+"), pieceLiteral("0"))
		case "natural":
			return computeCore.cond(computeCore.gt(value, 0n), pieceLiteral("+"), pieceLiteral("0"))
	}
}

/** The generation of `reads`: their forms concatenated in order, a generated field of Generated. */
const generationOf =
	(reads: Arr.NonEmptyReadonlyArray<Readable>): Generation =>
	(row) => {
		const [first, ...rest] = Arr.map(reads, (r) => formOf(row, r))
		const term = Arr.reduce(rest, first, (acc, next) => computeCore.concat(acc, next))
		return { g: generatedField(Generated, term, []) }
	}

/**
 * The schema of case `c` with its generation placed at `placement`: in the primary key, the template's key completed
 * by `g`; or outside it, completed by `name`, a bounded caller text, `g` a generated field no key holds.
 */
const schemaOf = (c: KeyGenerationCase, placement: Placement): unknown => {
	const declared = templates[c.template].declare(
		placement === "key" ? "g" : "name",
		generationOf(c.reads)
	)
	return schema("KeyGeneration", declared.relations, declared.statements, [])
}

/**
 * What compiling case `c`'s schema at `placement` gives: its installation, or the CompileError a builder threw or a
 * step returned. A builder refuses a malformed declaration by throwing, the compile by its Result, and a key
 * generation's refusal is either, so both are one outcome; anything a builder throws that is no CompileError is
 * thrown on.
 */
export const admissionOf = (
	c: KeyGenerationCase,
	placement: Placement
): Result.Result<unknown, CompileError> => compiled(() => schemaOf(c, placement))

/**
 * The installation of the schema `build` makes, or the CompileError its builders threw or its compile returned; anything
 * a builder throws that is no CompileError is thrown on.
 */
const compiled = (build: () => unknown): Result.Result<unknown, CompileError> => {
	const built = EffectResult.try(build)
	if (EffectResult.isFailure(built)) {
		const thrown = built.failure
		if (isCompileError(thrown)) {
			return Result.err(thrown)
		}
		throw thrown
	}
	return Result.flatMap(Result.flatMap(parseSchemaInput(built.success), ownInput), (owned) =>
		compileInstallation(owned, installOptions(owned))
	)
}

/**
 * What compiling a case's schema must give (INTERFACE.md §4, GENPK-A's admission): outside the key, the installation,
 * whatever the generation reads, as a generated field no key holds reads any field of its row; in the key, the
 * installation exactly when every field the generation reads is its caller's, and otherwise
 * GeneratedRefused at `g` for its least non-caller read by code units, named with how that field is written.
 */
export type Verdict =
	| { readonly kind: "admitted"; readonly template: TemplateName }
	| { readonly kind: "refused"; readonly read: Readable }

/** The least field `c`'s generation reads that its caller does not write, by name in code units. */
const leastForeign = (c: KeyGenerationCase): Readable | undefined =>
	Option.getOrUndefined(
		Arr.head(
			Arr.sort(
				Arr.filter(c.reads, (r) => r.writing !== "caller"),
				Order.mapInput(Order.String, (r: Readable) => r.field)
			)
		)
	)

/** What compiling `c`'s schema with its generation in the primary key must give. */
export const keyedVerdictOf = (c: KeyGenerationCase): Verdict => {
	const read = leastForeign(c)
	return read === undefined ? { kind: "admitted", template: c.template } : { kind: "refused", read }
}

/** The rule GeneratedRefused states for a key generation's read `r` its caller does not write (core/causes.ts GeneratedRule). */
export const keyReadRule = (r: Readable): Readonly<Record<string, string>> => ({
	kind: "keyReadsUnwritten",
	read: r.field,
	writing: r.writing
})

/** What a case reaches: admitted in its template, or refused for a writing it reads. */
export type KeyGenerationFeature =
	| `admitted in the ${TemplateName} template`
	| `refused: its ${Exclude<Writing, "caller">} read`
	| "refused: reads several writings outside its caller's"
	| "admitted: reads an unbounded text"

/** The writings outside its caller's that a case's generation reads, each once, in Writing's order. */
export const foreignWritings = (c: KeyGenerationCase): ReadonlyArray<Exclude<Writing, "caller">> =>
	Arr.filter(["drawn", "accumulated", "place"] as const, (w) =>
		Arr.some(c.reads, (r) => r.writing === w)
	)

/** Which instant a key generation reads: one its caller states as it read it (instant.stored), or its relation's clock. */
export type InstantRead = "stored" | "clock"

/** The field of each instant read: Seen's `seen`, a stored instant, or `at`, its clock, which its primary key holds. */
const instantField: Readonly<Record<InstantRead, string>> = { stored: "seen", clock: "at" }

/**
 * Seen(id, at, seen, body), keyed by (id, at, g): `at` its clock, the database's instant at each insert, which a key
 * holds after a field that orders it; `seen` an instant its caller states as it read it; and `g` a key generation over
 * the instant `read` names, a conditional between two pieces that reads it.
 */
const instantSchema = (read: InstantRead): unknown =>
	schema(
		"Instants",
		[
			keyedRelation(
				"Seen",
				{ id: int4, at: instant, seen: instant.stored, body: Body },
				["id", "at", "g"],
				(row) => {
					const value = row[instantField[read]]
					return {
						g: generatedField(
							Generated,
							computeCore.cond(computeCore.eq(value, value), pieceLiteral("i"), pieceLiteral("j")),
							[]
						)
					}
				}
			)
		],
		[],
		[]
	)

/** What compiling the instants schema over the read `read` gives: its installation, or its CompileError. */
export const instantAdmission = (read: InstantRead): Result.Result<unknown, CompileError> =>
	compiled(() => instantSchema(read))

/** The instant reads: one its caller states, and its clock. */
const instantReads = ["stored", "clock"] as const

/** A case of the instant box: which instant its key generation reads. */
export const instantReadGen: Gen<InstantRead> = (source) => source.draw(element(instantReads))

/**
 * How a family's member holds its group over an owner whose key holds a generation (INTERFACE.md §3): its own key
 * generation, the owner's expression over its same-named read (form (a), `same`); its own generation over another of
 * its fields (`otherRead`) or another expression over the same field (`otherExpression`); or the owner's value as a
 * caller field the fill copies (form (b), `copied`).
 */
export type MemberForm = "same" | "otherRead" | "otherExpression" | "copied"

/** The owner's generation, the member's own where it is the same: a path's ASCII lowering, or its whitespace collapsed. */
export type OwnerGeneration = "lowered" | "collapsed"

export interface MemberGroupCase {
	readonly owner: OwnerGeneration
	readonly member: MemberForm
}

const memberForms = ["same", "otherRead", "otherExpression", "copied"] as const

const ownerGenerations = ["lowered", "collapsed"] as const

/** The term of generation `g` over `field` of a row. */
const generationTerm = (
	g: OwnerGeneration,
	row: Readonly<Record<string, unknown>>,
	field: string
): unknown =>
	g === "lowered" ? computeCore.lowerAscii(row[field]) : computeCore.collapse(row[field])

/** The other of the two generations. */
const otherGeneration = (g: OwnerGeneration): OwnerGeneration =>
	g === "lowered" ? "collapsed" : "lowered"

/**
 * The schema of a member-group case: Doc (package, path, alias), keyed by its package and `g`, the owner's generation
 * over its path; and Line, an ordered family of Doc grouped by (package, g), whose `g` is its form's: a generation of its
 * own over its path or its alias, or a caller field of the generation's type.
 */
const memberGroupSchema = (c: MemberGroupCase): unknown => {
	const Doc = keyedRelation(
		"Doc",
		{ package: Name, path: Body, alias: Body, n: drawnField(natural, []) },
		["package", "g"],
		(row) => ({ g: generatedField(Generated, generationTerm(c.owner, row, "path"), []) })
	)
	const lineFields = {
		package: Name,
		path: Body,
		alias: Body,
		at: drawnField(natural, []),
		word: int4
	}
	const Line =
		c.member === "copied"
			? relation("Line", { ...lineFields, g: Generated }, ["package", "g", "at"], [])
			: keyedRelation("Line", lineFields, ["package", "g", "at"], (row) => ({
					g: generatedField(
						Generated,
						c.member === "same"
							? generationTerm(c.owner, row, "path")
							: c.member === "otherRead"
								? generationTerm(c.owner, row, "alias")
								: generationTerm(otherGeneration(c.owner), row, "path"),
						[]
					)
				}))
	return schema(
		"MemberGroup",
		[Doc, Line],
		[orderedBuilder(onBuilder(Line, ["package", "g", "at"]), finBuilder(Doc, "n"))],
		[]
	)
}

/** What compiling a member-group case gives: its installation, or the CompileError a builder threw or a step returned. */
export const memberGroupAdmission = (c: MemberGroupCase): Result.Result<unknown, CompileError> =>
	compiled(() => memberGroupSchema(c))

/**
 * Whether a member-group case's schema is admitted (INTERFACE.md §3): a member's group over an owner's key generation is
 * its own key generation of the owner's expression over its same-named read, or a copy of the owner's value; a member
 * generating anything else names no owner by its group, MalformedDescription.
 */
export const memberGroupAdmitted = (c: MemberGroupCase): boolean =>
	c.member === "same" || c.member === "copied"

export const memberGroupGen: Gen<MemberGroupCase> = (source) => ({
	owner: source.draw(element(ownerGenerations)),
	member: source.draw(element(memberForms))
})
