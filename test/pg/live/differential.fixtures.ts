/** What the properties of differential.test.ts read: its spaces, models and helpers. */

import type { Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LiveValue } from "#test/support/live/system.ts"
import { type Answer, publicRows, shapeOf } from "#test/support/oracle/public/answer.ts"
import { factRecord, hostValue } from "#test/support/oracle/public/build.ts"
import { admittedSketchGen, type CaseSketch } from "#test/support/oracle/public/generate.ts"
import type {
	ProgramCase,
	ProgramRead,
	ProgramSchema
} from "#test/support/oracle/public/program.ts"
import { storedInput } from "#test/support/oracle/runner.ts"

export class Differs extends Data.TaggedError("Differs")<{ readonly report: string }> {}

export type Feature =
	| "a set read"
	| "an ordered read"
	| "an attachment"
	| "a relation parameter"
	| "a read of no row"
	| "a read of several rows"
	| "a column the reference declines"
	| "a read refused for a key over prose"
	| "an admitted program whose live answers match the reference over an index read"

export const cases = 40

/** The admitted program over an index read, with the sketches a witness whose turn aims at it draws (aimed). */
export const aims: ReadonlyArray<readonly [Feature, Gen<CaseSketch>]> = [
	[
		"an admitted program whose live answers match the reference over an index read",
		admittedSketchGen
	]
]

/**
 * Whether `error` is the compile's refusal of indexes over prose fields of `schema`, the generated schema's text with
 * no byte bound: UnrepresentableKey, each key it names faulted unboundedText of a prose field of a relation whose fields
 * are every field of that key.
 */
export const refusesProseKey = (schema: ProgramSchema, error: CompileError): boolean => {
	const reason = error.reason
	return (
		reason._tag === "UnrepresentableKey" &&
		Arr.every(reason.keys, (key) => {
			const fault = key.fault
			return (
				fault.kind === "unboundedText" &&
				Arr.some(
					schema.relations,
					(r) =>
						Arr.some(r.fields, (f) => f.kind === "prose" && f.name === fault.field) &&
						Arr.every(key.key, (k) => Arr.some(r.fields, (f) => f.name === k))
				)
			)
		})
	)
}

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

/** The member a query read is served as, by its place among the case's reads. */
export const readMember = (place: number): string => `read${place}`

/** A read's parameters as a call takes them: each scalar's host value, each relation parameter's facts. */
export const paramsOf = (read: QueryRead): Readonly<Record<string, unknown>> =>
	Rec.fromEntries([
		...Arr.map(read.params, (p): readonly [string, unknown] => [
			p.name,
			hostValue(p.value, p.type)
		]),
		...Arr.map(read.relations, (r): readonly [string, unknown] => [
			r.name,
			Arr.map(r.rows, (fact) => factRecord(r.relation, fact))
		])
	])

/** The case's facts as the oracle loader's records, each value in the spelling its fact drew. */
export const directFacts = (c: ProgramCase) =>
	Rec.fromEntries(
		Arr.map(c.schema.relations, (r) => [
			r.name,
			Arr.map(c.facts.get(r.name) ?? [], (fact) =>
				Rec.fromEntries(
					Arr.flatMap(r.fields, (f, i): ReadonlyArray<readonly [string, unknown]> => {
						const value = fact[i]
						return value === undefined ? [] : [[f.name, storedInput(value, f.type)]]
					})
				)
			)
		])
	)

/** A value's rows as the public answer reads delivered rows. */
export const answerOf = (read: QueryRead, value: LiveValue): Answer =>
	publicRows(shapeOf(read.query), [...value])
