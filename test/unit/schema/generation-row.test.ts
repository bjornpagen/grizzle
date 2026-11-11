/**
 * A generation expression reads the fields its caller writes (core/causes.ts GeneratedRule readsUnwritten): PostgreSQL
 * generates the column from them alone, and a drawn or an accumulated field, which grizzle writes on the host, is no
 * generation expression's to read. The public type leaves both out of the callback's row; a JavaScript caller's row
 * types them by their declared types, so an expression over one is built and reaches the checker, which refuses it by
 * name.
 *
 * Each case draws a relation R of up to two drawn counts, each the owner of a counted family, up to two accumulated
 * sets each a fold of the first family fills, and up to two sets the caller writes, every field under a drawn name, and
 * a generated field reading a drawn nonempty set of them, summed in a drawn order. The model: the least read in code
 * units grizzle writes is refused, with its writing; a read of the caller's fields alone is admitted.
 *
 * Oracle: the model above, a specification: the least read in code units among the fields grizzle writes.
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): generation-row-last-read-named (the greatest such read named, not the
 * least).
 */
import { describe, it } from "@effect/vitest"
import { drawn as drawnCase, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { codePoint, type Gen, int, shuffled, string, uniqueKeys } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { accumulated, Bits, bits, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { generatedField, generatedRelation, relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import {
	countedBuilder,
	finBuilder,
	foldBuilder,
	monoids,
	mutableBuilder,
	onBuilder
} from "#compiler/schema/statements.ts"
import { assert, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"

const Flag = closed("Flag", ["a", "b"])

type Writing = "drawn" | "accumulated" | "caller"

interface RowField {
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

const generationCaseGen: Gen<GenerationCase> = (source) => {
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
const schemaOf = (c: GenerationCase) => {
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

type Situation = "refused at an accumulated read" | "refused at a drawn read" | "admitted"

describe("a generation expression's row", () => {
	it.effect(
		"admits a read of the caller's fields and refuses a read of a drawn or an accumulated field by name",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/generation-row",
						draw: drawnCase(generationCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the least read in code units grizzle writes is refused with its writing; the caller's fields alone are admitted"
						},
						coverage: required<Situation>(
							["refused at an accumulated read", "refused at a drawn read", "admitted"],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const artifacts = testArtifacts(schemaOf(c), testCompile)
							const unwritten = Arr.sort(
								Arr.filter(c.reads, (f) => f.writing !== "caller"),
								Order.mapInput(Order.String, (f: RowField) => f.name)
							)
							const [least] = unwritten
							if (least === undefined) {
								succeeded(artifacts, "a read of the caller's fields alone is admitted")
								k.note("admitted")
								return
							}
							const reason = refused(
								artifacts,
								"GeneratedRefused",
								"a generation expression reads no field grizzle writes"
							).reason
							if (reason._tag !== "GeneratedRefused") {
								return assert.fail("a GeneratedRefused")
							}
							assert.deepEqual(
								{ relation: reason.relation, field: reason.field, rule: reason.rule },
								{
									relation: "R",
									field: "zz",
									rule: {
										kind: "readsUnwritten",
										read: least.name,
										writing: least.writing === "drawn" ? "drawn" : "accumulated"
									}
								},
								"the refusal names the generated field, the least field grizzle writes it reads and its writing"
							)
							k.note(
								least.writing === "accumulated"
									? "refused at an accumulated read"
									: "refused at a drawn read"
							)
						})
				)
			)
	)
})
