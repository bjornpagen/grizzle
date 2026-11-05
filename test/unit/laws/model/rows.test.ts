import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { heapTupleMaxBytes } from "#compiler/core/limits.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import { rowBytes, rowColumn, wideRow } from "#compiler/laws/model/rows.ts"
import { assert, refused } from "#test/support/assert.ts"
import { f, relation } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { compiled, modelOf } from "#test/unit/laws/model/natives.ts"

/**
 * A relation's rows must fit one heap tuple (MaxHeapTupleSize): its fields and law columns are refused exactly when a
 * row of them, every variable-length value moved out of line, takes more. The oracle is PostgreSQL's layout turned
 * into a checker, written from heaptuple.c and pg_type's catalog alone, never from the engine's datum bounds: a row is
 * its header, SizeofHeapTupleHeader (23) and a null bitmap of a bit per column when one may be NULL, MAXALIGNed (8);
 * then each fixed-width column at its pg_type typlen and typalign, widest alignment first, and each unbounded text at
 * its TOAST pointer's 18 bytes, unaligned.
 *
 * The limit is drawn small (rule 10): each case's limit is its own row's size, so the refusal is judged at the exact
 * boundary, accepted at it and refused one byte under it. Bound: rows of 0 to 12 columns drawn from int2, int4, int8,
 * bool, uuid, a closed id and an unbounded text, each NULL-able or not, 300 runs. The law model applies it at the
 * real MaxHeapTupleSize: a relation of a uuid key and k bigint fields compiles at the largest k that fits and is refused
 * at the next.
 */

/** A column kind with its pg_type storage: typlen and typalign in bytes, or a varlena held as a TOAST pointer. */
interface Kind {
	readonly name: "int2" | "int4" | "int8" | "bool" | "uuid" | "closed id" | "text"
	readonly desc: FieldDesc
	readonly storage: { readonly typlen: number; readonly typalign: number } | "varlena"
}

const kinds: Arr.NonEmptyReadonlyArray<Kind> = [
	{ name: "int2", desc: f.smallint, storage: { typlen: 2, typalign: 2 } },
	{ name: "int4", desc: f.integer, storage: { typlen: 4, typalign: 4 } },
	{ name: "int8", desc: f.bigint, storage: { typlen: 8, typalign: 8 } },
	{ name: "bool", desc: f.boolean, storage: { typlen: 1, typalign: 1 } },
	{ name: "uuid", desc: f.uuid, storage: { typlen: 16, typalign: 1 } },
	{ name: "closed id", desc: f.closedId("R"), storage: { typlen: 2, typalign: 2 } },
	{ name: "text", desc: f.wildcard, storage: "varlena" }
]

interface Column {
	readonly kind: Kind
	readonly nullable: boolean
}

const columnGen = (source: Parameters<typeof boolean>[0]): Column => ({
	kind: element(kinds)(source),
	nullable: boolean(source)
})

/** The checker's size of a row: heaptuple.c's header and data area, by pg_type's catalog. */
const specified = (columns: ReadonlyArray<Column>): number => {
	const align = (n: number, a: number): number => Math.ceil(n / a) * a
	const hasNull = Arr.some(columns, (c) => c.nullable)
	const hoff = align(23 + (hasNull ? Math.ceil(columns.length / 8) : 0), 8)
	const ordered = Arr.sort(columns, (a: Column, b: Column) => {
		const alignOf = (c: Column) => (c.kind.storage === "varlena" ? 1 : c.kind.storage.typalign)
		return alignOf(b) - alignOf(a) > 0 ? 1 : alignOf(b) - alignOf(a) < 0 ? -1 : 0
	})
	return Arr.reduce(ordered, hoff, (offset, c) =>
		c.kind.storage === "varlena"
			? offset + 18
			: align(offset, c.kind.storage.typalign) + c.kind.storage.typlen
	)
}

type Feature = "a NULL-able column" | "a varlena" | "mixed alignments" | "no column"
const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a NULL-able column",
	"a varlena",
	"mixed alignments",
	"no column"
]

describe("a relation's rows fit one heap tuple", () => {
	it.effect("a row is refused exactly when it takes more than the limit, at the boundary", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/laws/model/rows",
					draw: drawn(array(columnGen, { min: 0, max: 12 })),
					literal: Formatter.format,
					kept: [],
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang,
					coverage: required<Feature>(features, { cases: 300, sense: notesOnly }),
					oracle: { kind: "specification", name: "heaptuple.c's row layout by pg_type's catalog" }
				},
				(columns, c) =>
					Effect.sync(() => {
						if (Arr.some(columns, (x) => x.nullable)) {
							c.note("a NULL-able column")
						}
						if (Arr.some(columns, (x) => x.kind.storage === "varlena")) {
							c.note("a varlena")
						}
						if (new Set(Arr.map(columns, (x) => x.kind.name)).size > 1) {
							c.note("mixed alignments")
						}
						if (columns.length === 0) {
							c.note("no column")
						}
						const row = Arr.map(columns, (x) => rowColumn(x.kind.desc, x.nullable))
						const bytes = specified(columns)
						assert.equal(rowBytes(row), bytes, "the row's size is heaptuple.c's")
						assert.equal(wideRow("R", row, bytes), undefined, "a row at the limit fits")
						assert.ok(
							wideRow("R", row, bytes - 1) !== undefined,
							"a row one byte over the limit is refused"
						)
					})
			)
		)
	)

	it("the law model refuses a relation one bigint past MaxHeapTupleSize, and admits the one before it", () => {
		/** The most bigint fields beside a uuid key one heap tuple holds: 24 header bytes, 16 of the key, 8 a field. */
		const fits = Math.floor((heapTupleMaxBytes.value - 24 - 16) / 8)
		const schemaWith = (k: number) => ({
			name: "Wide",
			relations: [
				relation(
					"Wide",
					{ id: f.uuid, ...Rec.fromEntries(Arr.makeBy(k, (i) => [`c${i}`, f.bigint] as const)) },
					["id"]
				)
			],
			statements: [],
			extends: undefined
		})
		modelOf(schemaWith(fits))
		refused(compiled(schemaWith(fits + 1)), "UnsupportedLawFamily")
	})
})
