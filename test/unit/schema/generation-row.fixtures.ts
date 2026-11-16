/** What the properties of generation-row.test.ts read: its spaces, models and helpers. */

import { codePoint, type Gen, int, shuffled, string, uniqueKeys } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { accumulated, Bits, bits, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	generatedField,
	generatedRelation,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	countedBuilder,
	finBuilder,
	foldBuilder,
	monoids,
	mutableBuilder,
	onBuilder
} from "#compiler/schema/statements.ts"
import { nonEmpty } from "#test/support/assert.ts"

const Flag = closed("Flag", ["a", "b"])

type Writing = "drawn" | "accumulated" | "caller"

export interface RowField {
	readonly name: string
	readonly writing: Writing
}

interface GenerationCase {
	readonly fields: Arr.NonEmptyReadonlyArray<RowField>
	/** The fields the generated field reads, in the order its sum adds them. */
	readonly reads: Arr.NonEmptyReadonlyArray<RowField>
}

/** Names of one to three letters a to f, so none is `id` or the generated field's `zz`. */
const nameGen: Gen<string> = string(codePoint(0x61, 0x66), { min: 1, max: 3 })

export const generationCaseGen: Gen<GenerationCase> = (source) => {
	const counts = source.draw(int(0, 2))
	const sets = counts > 0 ? source.draw(int(0, 2)) : 0
	const callers = source.draw(int(counts + sets === 0 ? 1 : 0, 2))
	const writings: ReadonlyArray<Writing> = [
		...Arr.map(indices(counts), (): Writing => "drawn"),
		...Arr.map(indices(sets), (): Writing => "accumulated"),
		...Arr.map(indices(callers), (): Writing => "caller")
	]
	const names = source.draw(uniqueKeys(nameGen, { min: writings.length, max: writings.length }))
	const fields = nonEmpty(
		Arr.map(Arr.zip(names, writings), ([name, writing]) => ({ name, writing })),
		"R's fields"
	)
	const reads = nonEmpty(
		source.draw(shuffled(fields, { min: 1, max: fields.length })),
		"the generated field's reads"
	)
	return { fields, reads }
}

const withWriting = (c: GenerationCase, writing: Writing): ReadonlyArray<string> =>
	Arr.flatMap(c.fields, (f) => (f.writing === writing ? [f.name] : []))

/** The schema whose generated field reads `reads`, a JavaScript caller's: the sum of each read's count. */
export const schemaOf = (c: GenerationCase) => {
	const declared = Rec.fromEntries(
		Arr.map(c.fields, (f) => {
			switch (f.writing) {
				case "drawn":
					return [f.name, drawn(natural)] as const
				case "accumulated":
					return [f.name, accumulated(bits(Flag), Bits.of(Flag, []))] as const
				case "caller":
					return [f.name, bits(Flag)] as const
			}
		})
	)
	const R = generatedRelation(
		"R",
		{ id: uuid, ...declared },
		["id"],
		(r: Readonly<Record<string, unknown>>) => {
			const [first, ...rest] = Arr.map(c.reads, (f) =>
				f.writing === "drawn" ? computeCore.base(r[f.name]) : computeCore.cardinality(r[f.name])
			)
			const sum = Arr.reduce(rest, first, (s, t) => computeCore.add(s, t))
			return { zz: generatedField(pg.bigint, computeCore.cast(sum, pg.bigint), []) }
		},
		[]
	)
	const families = Arr.map(withWriting(c, "drawn"), (count, i) => {
		const M = relation(`M${i}`, { o: uuid, id: uuid, flags: bits(Flag) }, ["id"], [])
		return { M, members: countedBuilder(onBuilder(M, ["o"]), finBuilder(R, count)) }
	})
	const folds = Option.match(Arr.head(families), {
		onNone: () => [],
		onSome: (first) =>
			Arr.map(withWriting(c, "accumulated"), (set) =>
				foldBuilder(
					first.members,
					monoids.or,
					onBuilder(first.M, ["o", "flags"]),
					onBuilder(R, ["id", set])
				)
			)
	})
	return schema(
		"GenerationRow",
		[Flag, R, ...Rec.values(Rec.fromEntries(Arr.map(families, (f, i) => [`M${i}`, f.M] as const)))],
		[...Arr.map(families, (f) => f.members), ...folds, mutableBuilder(R)],
		[]
	)
}

export type Situation = "refused at an accumulated read" | "refused at a drawn read" | "admitted"
