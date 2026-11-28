/**
 * What the properties of preview.test.ts read: a case's schema, the preview case of test/pg/write/preview (a drawn
 * schema of families beside the palette, an instance of it and the fault its call states) beside the stamps a schema
 * may hold, a clock, a reference it stamps and a place, or with them a reference no one clock stamps; the calls a case
 * makes, each the
 * case's facts with a drawn set of relations stated and every other empty; and the served write every call's preview is
 * held to, insertAll over every top-level relation an insert compiles of.
 */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int, map, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { parseBuiltSchema } from "#compiler/program/input.ts"
import { type PreviewWrite, previewWriteOf } from "#compiler/program/preview.ts"
import { builtLawModel, schemaArtifacts } from "#compiler/program/schema.ts"
import { compileParsed } from "#compiler/program/workload/change.ts"
import { instant, place, int4 } from "#compiler/public/fields.ts"
import { type AnySchema, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { inForce, type Transport } from "#compiler/runtime/write/transport.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { insertableNamesOf } from "#compiler/schema/world.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet, parseChangeSet } from "#compiler/write/changeset/value.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import {
	caseGen as previewCaseGen,
	type PreviewCase,
	previewInput
} from "#test/support/pg/write/preview/preview.fixtures.ts"

/** A situation a case reaches. */
export type PreviewCostFeature =
	| "a call stating one relation"
	| "a call stating several families"
	| "a call writing a family it states only a member of"
	| "a call reusing a compiled insert"
	| "a reference its insert stamps beside its clock's"
	| "a row whose key the database stamps"
	| "two rows whose key's stated fields are one"
	| "an insert that does not compile, refused"
	| "rows given"
	| "a refusal"

/**
 * The stamps a case's schema holds beside its families and palette: none; a clock, Shift's at at each crew, a reference
 * Badge's at carries to it, which a Badge's insert stamps from Shift's clock beside an insert of Shift, and a place,
 * Turn's n in each crew; or beside them another clock, Watch's, and Stray, whose at both carry, so no one clock stamps
 * it and no insert of Stray compiles (write/frontend/instants.ts `unstampable`). Shift's, Watch's and Turn's keys each
 * hold the field the database stamps.
 */
export type Stamps = "none" | "stamped" | "unstampable"

/** A case: a preview case, its schema's stamps, their facts, and the relations each of its calls states rows of. */
export interface PreviewCostCase {
	readonly preview: PreviewCase
	readonly stamps: Stamps
	readonly crews: ReadonlyArray<number>
	readonly seats: number
	readonly calls: ReadonlyArray<ReadonlyArray<string>>
}

/** The stamps' relations and statements of `stamps`, built anew for each schema. */
const stampsOf = (stamps: Stamps) => {
	const Shift = relation("Shift", { crew: int4, at: instant, note: int4 }, ["crew", "at"])
	const Badge = relation("Badge", { id: int4, crew: int4, at: instant }, ["id"])
	const Turn = relation("Turn", { crew: int4, n: place, seat: int4 }, ["crew", "n"])
	const Watch = relation("Watch", { crew: int4, at: instant }, ["crew", "at"])
	const Stray = relation("Stray", { id: int4, crew: int4, at: instant }, ["id"])
	switch (stamps) {
		case "none":
			return { relations: [], statements: [] }
		case "stamped":
			return {
				relations: [Shift, Badge, Turn],
				statements: [contained(on(Badge, "crew", "at"), on(Shift, "crew", "at"))]
			}
		case "unstampable":
			return {
				relations: [Shift, Badge, Turn, Watch, Stray],
				statements: [
					contained(on(Badge, "crew", "at"), on(Shift, "crew", "at")),
					contained(on(Stray, "crew", "at"), on(Shift, "crew", "at")),
					contained(on(Stray, "crew", "at"), on(Watch, "crew", "at"))
				]
			}
	}
}

/** The relations whose key holds a field the database stamps, a clock's or a place's, and the facts a case states of
 * them. */
export const stampedRelations = ["Shift", "Turn", "Watch"] as const

/**
 * The stamps' facts of `stamps` as insertAll takes them: at each crew a shift and a watch, each at the clock it stamps,
 * a badge, a turn at each of its seats, at the place it stamps, and, where no clock stamps it, a stray.
 */
const stampFacts = (
	stamps: Stamps,
	crews: ReadonlyArray<number>,
	seats: number
): Readonly<Record<string, ReadonlyArray<unknown>>> => {
	const badges = Arr.map(crews, (crew, id) => ({ id, crew }))
	const common = {
		Shift: Arr.map(crews, (crew) => ({ crew, note: crew * 10 })),
		Badge: badges,
		Turn: Arr.flatMap(crews, (crew) => Array.from({ length: seats }, (_, seat) => ({ crew, seat })))
	}
	switch (stamps) {
		case "none":
			return {}
		case "stamped":
			return common
		case "unstampable":
			return { ...common, Watch: Arr.map(crews, (crew) => ({ crew })), Stray: badges }
	}
}

/**
 * A case's schema under `name` (the preview case's relations and statements, test/pg/write/preview previewInput, beside
 * its stamps') and its facts, every top-level relation's.
 */
export const caseSchema = (k: PreviewCostCase, name: string) => {
	const input = previewInput(k.preview)
	const stamps = stampsOf(k.stamps)
	return {
		schema: schema(
			name,
			[...input.relations, ...stamps.relations],
			[...input.statements, ...stamps.statements]
		),
		facts: { ...input.facts, ...stampFacts(k.stamps, k.crews, k.seats) }
	}
}

/** The palette alone as a preview reads it, under `name`, with its facts: the families' relations and the stamps left
 * out. */
export const paletteSchema = (k: PreviewCostCase, name: string) => {
	const { palette } = previewInput(k.preview)
	return { schema: schema(name, palette.relations, palette.statements), facts: palette.facts }
}

/** A call's facts: `facts`, every relation outside `stated` with no row. */
export const callOf = (
	facts: Readonly<Record<string, ReadonlyArray<unknown>>>,
	stated: ReadonlyArray<string>
): Readonly<Record<string, ReadonlyArray<unknown>>> =>
	Rec.map(facts, (rows, relation) => (stated.includes(relation) ? rows : []))

/** The cases: a preview case, its stamps, one to three crews, and one to three calls, each of a drawn set of relations. */
export const previewCostCaseGen: Gen<PreviewCostCase> = (source) => {
	const preview = source.draw(previewCaseGen.space)
	const stamps = source.draw(element(["none", "stamped", "unstampable"] as const))
	const crews = Array.from({ length: source.draw(int(1, 3)) }, (_, i) => i + 1)
	const seats = source.draw(int(1, 2))
	const relations = Rec.keys({
		...previewInput(preview).facts,
		...stampFacts(stamps, crews, seats)
	})
	const calls = Array.from({ length: source.draw(int(1, 3)) }, () =>
		source.draw(map(subset(relations, { min: 1, max: relations.length }), (s) => [...s]))
	)
	return { preview, stamps, crews, seats, calls }
}

/** The law model of a case's schema, which every reader of the schema value reads. */
export const modelOf = (s: AnySchema): LawModel => {
	const model = Engine.flatMap(parseBuiltSchema(s, captureLoc("insertPreview", [])), builtLawModel)
	if (!model.ok) {
		throw model.error
	}
	return model.value
}

/** What every preview of a case binds under: the wire's Bind frame. */
export const transport: Transport = inForce(bindFrame)

/** The relations of a case whose insert compiles: every top-level relation but Stray, which no clock stamps. */
export const servedRelations = (s: AnySchema): ReadonlyArray<string> =>
	Arr.filter(insertableNamesOf(s), (name) => name !== "Stray")

/**
 * The served write of `s`'s insertAll over `relations`, each member an array, as an application's flight runs it: its
 * compile by the one every write takes, under the rosters' declared-order codes, projected and loaded, then read as a
 * preview reads a write (program/preview.ts previewWriteOf); or the CompileError its compile refuses it by.
 */
export const servedWrite = (
	s: AnySchema,
	relations: ReadonlyArray<string>
): Engine.Result<PreviewWrite, CompileError> => {
	const built = parseBuiltSchema(s, captureLoc("insertPreview", []))
	if (!built.ok) {
		return built
	}
	const codes = firstCodebook(rostersOf(modelOf(s).owned))
	return Engine.flatMap(schemaArtifacts(built.value, { codes }), (artifacts) =>
		Engine.map(
			compileParsed(
				artifacts,
				defined(
					parseChangeSet(
						ChangeSet.empty(s).insertAll(
							Rec.fromEntries(Arr.map(relations, (name) => [name, []] as const))
						)
					),
					"insertAll's value, a ChangeSet"
				),
				new Set(),
				"serializable",
				noClock,
				transactionClock
			),
			({ compiled }) =>
				previewWriteOf(compiled.frontend, flightOf(servableWrite(compiled), codes, noAdvice))
		)
	)
}
