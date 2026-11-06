import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { accumulated, Bits, bits, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import {
	closed,
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * A generation expression reads the fields its caller writes (core/causes.ts GeneratedRule readsUnwritten): PostgreSQL
 * generates the column from them alone, and a drawn or an accumulated field, which grizzle writes on the host, is no
 * generation expression's to read. The public type leaves both out of the callback's row; a JavaScript caller's row
 * types them by their declared types, so an expression over one is built and reaches the checker, which refuses it by
 * name, where it used to fail at the builder as a literal standing first.
 *
 * The box: every nonempty set of reads among an accumulated set, a drawn count and a set the caller writes, each the
 * owner R of a counted family whose fold fills the accumulated set, the generated field the sum of what it reads. The
 * model: the least read in code units grizzle writes is refused, with its writing; a read of the caller's set alone is
 * admitted.
 */
const Flag = closed("Flag", ["a", "b"])

const fields = ["acc", "n", "w"] as const
type Read = (typeof fields)[number]

/** The writing of each field the caller does not write. */
const unwritten: { readonly [F in Read]: "drawn" | "accumulated" | undefined } = {
	acc: "accumulated",
	n: "drawn",
	w: undefined
}

/** Every nonempty set of reads, in code-unit order. */
const readSets: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Read>> = [
	["acc"],
	["n"],
	["w"],
	["acc", "n"],
	["acc", "w"],
	["n", "w"],
	["acc", "n", "w"]
]

/** The schema whose generated field g reads `reads`, a JavaScript caller's: the sum of each read's count. */
const schemaReading = (reads: Arr.NonEmptyReadonlyArray<Read>) => {
	const R = generatedRelation(
		"R",
		{
			id: uuid,
			acc: accumulated(bits(Flag), Bits.of(Flag, [])),
			n: drawn(natural),
			w: bits(Flag)
		},
		["id"],
		(r) => {
			const [first, ...rest] = Arr.map(reads, (f) =>
				f === "n" ? computeCore.base(r[f]) : computeCore.cardinality(r[f])
			)
			const sum = Arr.reduce(rest, first, (s, t) => computeCore.add(s, t))
			return { g: generatedField(pg.bigint, computeCore.cast(sum, pg.bigint), []) }
		},
		[]
	)
	const M = relation("M", { o: uuid, id: uuid, flags: bits(Flag) }, ["id"])
	const members = counted(on(M, "o"), fin(R, "n"))
	return schema("GenerationRow", { Flag, R, M }, [
		members,
		fold(members, Monoid.or, on(M, "o", "flags"), on(R, "id", "acc")),
		mutable(R)
	])
}

type Situation = "refused at an accumulated read" | "refused at a drawn read" | "admitted"

describe("a generation expression's row", () => {
	it.effect(
		"admits a read of the caller's fields and refuses a read of a drawn or an accumulated field by name",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/generation-row",
						generator: element(readSets),
						literal: Formatter.format,
						limit: readSets.length,
						coverage: requiredInSpace<Situation>([
							"refused at an accumulated read",
							"refused at a drawn read",
							"admitted"
						]),
						caseHang
					},
					(reads, c) =>
						Effect.sync(() => {
							const artifacts = testArtifacts(schemaReading(reads), testCompile)
							const read = Arr.findFirst(reads, (f) => {
								const writing = unwritten[f]
								return writing === undefined ? Option.none() : Option.some({ read: f, writing })
							})
							if (Option.isNone(read)) {
								succeeded(artifacts, "a read of the caller's fields alone is admitted")
								c.note("admitted")
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
									field: "g",
									rule: {
										kind: "readsUnwritten",
										read: read.value.read,
										writing: read.value.writing
									}
								},
								"the refusal names the generated field, the least field grizzle writes it reads and its writing"
							)
							c.note(
								read.value.writing === "accumulated"
									? "refused at an accumulated read"
									: "refused at a drawn read"
							)
						})
				)
			)
	)
})
