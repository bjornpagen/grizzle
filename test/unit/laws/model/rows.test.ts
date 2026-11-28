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
 * real MaxHeapTupleSize, drawn on both sides of it: a relation of a uuid key, up to six drawn fields and k bigint fields
 * compiles at the largest k whose row fits and the one before it, and is refused at the next.
 *
 * Features: a NULL-able column, a varlena, mixed alignments and no column for the layout; within, at and past the
 * bound, a varlena and mixed alignments for the law model.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { heapTupleMaxBytes } from "#compiler/laws/model/model.ts"
import { rowBytes, rowColumn, wideRow } from "#compiler/laws/model/rows.ts"
import { refused } from "#test/support/assert.ts"
import { f, relation } from "#test/support/fixtures/ir/desc.ts"
import { compiledModel, modelOf } from "#test/support/unit/laws/model/natives.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	type BoundFeature,
	type Column,
	columnGen,
	type Feature,
	features,
	int8,
	specified,
	storedKinds,
	uuidKind
} from "#test/unit/laws/model/rows.fixtures.ts"

/** A relation's rows fit one heap tuple a row is refused exactly when it takes more than the limit, at the boundary. Its budget is its suite's before it was a property (test/unit/laws/model/rows.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aRelationsRowsFitOneHeapTupleARowIsRefusedExactlyWhenItTakesMoreThanTheLimitAtTheBoundary =
	property.explore(array(columnGen, { min: 0, max: 12 }), {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (columns) =>
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
			}),
		oracle: { kind: "specification", name: "heaptuple.c's row layout by pg_type's catalog" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/rows.ts",
				original: "\tconst header = alignUp(heapTupleHeaderBytes + bitmap, maxAlign)",
				replacement: "\tconst header = alignUp(heapTupleHeaderBytes, maxAlign)",
				why: "A row's null bitmap uncounted (laws/model/rows.ts rowBytes); the layout fails."
			}
		]
	})

/** A relation's rows fit one heap tuple the law model admits a relation whose row reaches MaxHeapTupleSize, and refuses one a bigint past it. Its budget is its suite's before it was a property (test/unit/laws/model/rows.test.ts at 4ca3036a): 40 runs and 100 steered cases. */
export const aRelationsRowsFitOneHeapTupleTheLawModelAdmitsARelationWhoseRowReachesMaxHeapTupleSizeAndRefusesOneABigintPastIt =
	property.explore(
		(source) =>
			[
				source.draw(array(element(storedKinds), { min: 0, max: 6 })),
				source.draw(int(-1, 1))
			] as const,
		{
			needs: {},
			budget: { runs: 40, steered: 100 },
			situations: [
				"within the bound",
				"at the bound",
				"past the bound",
				"a varlena",
				"mixed alignments"
			] satisfies ReadonlyArray<Reached<BoundFeature>>,
			check:
				(_, c: Case<BoundFeature>) =>
				([prefix, offset]) =>
					Effect.sync(() => {
						const columns = (k: number): ReadonlyArray<Column> => [
							{ kind: uuidKind, nullable: false },
							...Arr.map(prefix, (kind): Column => ({ kind, nullable: false })),
							...upTo(k, (): Column => ({ kind: int8, nullable: false }))
						]
						let fits = 0
						while (specified(columns(fits + 1)) <= heapTupleMaxBytes) {
							fits += 1
						}
						const k = fits + offset
						const bytes = specified(columns(k))
						c.note(
							offset < 0 ? "within the bound" : offset === 0 ? "at the bound" : "past the bound"
						)
						if (Arr.some(prefix, (kind) => kind.storage === "varlena")) {
							c.note("a varlena")
						}
						if (new Set(Arr.map(prefix, (kind) => kind.name)).size > 1) {
							c.note("mixed alignments")
						}
						const desc = {
							name: "Wide",
							relations: [
								relation(
									"Wide",
									{
										id: f.uuid,
										...Rec.fromEntries(Arr.map(prefix, (kind, i) => [`p${i}`, kind.desc] as const)),
										...Rec.fromEntries(upTo(k, (i) => [`c${i}`, f.bigint] as const))
									},
									["id"]
								)
							],
							statements: [],
							bases: [] as const
						}
						if (bytes <= heapTupleMaxBytes) {
							modelOf(desc)
							return
						}
						refused(compiledModel(desc), "UnsupportedLawFamily")
					}),
			oracle: {
				kind: "specification",
				name: "heaptuple.c's row layout by pg_type's catalog, against MaxHeapTupleSize"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/laws/model/rows.ts",
					original: "\treturn bytes > limit",
					replacement: "\treturn bytes >= limit",
					why: "A row of exactly the limit refused (laws/model/rows.ts wideRow); the law model at MaxHeapTupleSize fails."
				}
			]
		}
	)
