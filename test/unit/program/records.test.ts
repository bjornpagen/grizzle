/**
 * A query's records (program/records.ts records and recordsQuery) over a box of flat queries: each column of a relation
 * holding a field of every type a column may be stored as, alone; every column; and every column beside a head literal
 * of each JavaScript type. The records' root `FoundRow` holds the owner's field, then one field per column the query
 * finds, each the column's own field, its declaration and its column the query's, and no head literal, keyed by the
 * owner's key; and recordsQuery over a level listing the records reads them through the query's own decoder, which
 * binds the read's compiled program in either artifact.
 *
 * Oracle: the relation the query reads, each stored field's declaration its own field's (schema/relation.ts
 * describeDeclared), and its column's form the query's decoder's.
 *
 * Features: none; the box is exhausted.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rcd, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import {
	type Columned,
	columnForm,
	type ColumnForm,
	type DecoderForm
} from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { natural } from "#compiler/public/fields.ts"
import { records, recordsQuery, schema } from "#compiler/public/schema.ts"
import { bindGroups } from "#compiler/schema/record.ts"
import { describeDeclared } from "#compiler/schema/relation.ts"
import {
	cellQuery,
	heldExactly,
	holdsExactly,
	Item,
	literalKey,
	programOf,
	Rec,
	type RecordsCell,
	recordsBox
} from "#test/unit/program/records.fixtures.ts"

/** The declaration a field holds (schema/relation.ts describeDeclared). */
const declaration = (field: unknown, what: string) =>
	describeDeclared(field, SourceLoc(what, [])).desc

/** The column forms a query's decoder reads its record's fields by, by key: a one-heading query's record's. */
const formColumns = (form: DecoderForm): ReadonlyMap<string, ColumnForm> => {
	if (form.kind !== "record") {
		throw new Error(`a flat query's decoder is a record's: ${Formatter.format(form)}`)
	}
	return new Map(
		Arr.flatMap(form.fields, ([key, field]) =>
			field.kind === "column" ? [[key, field.column] as const] : []
		)
	)
}

/**
 * A flat query's records hold the owner's field then each column it finds as its own field, and no head literal, keyed
 * by the owner's key; their read is delivered through the query's own decoder, which binds its compiled program.
 */
export const aQuerysRecordsHoldEachColumnAsItsOwnFieldAndReadBackThroughItsOwnDecoder =
	property.exhaust(
		finite((source) => source.draw(element(recordsBox))),
		{
			needs: {},
			situations: [],
			check: () => (cell: RecordsCell) =>
				Effect.sync(() => {
					const what = `the records of ${Formatter.format(cell)}`
					const q = cellQuery(cell)
					if (cell.kind === "union" && !heldExactly(cell.literals)) {
						const refused = catchCompileError(() => records("Found", q, { at: natural }, ["at"]))
						assert.ok(
							!refused.ok && refused.error.reason._tag === "UnsupportedOperation",
							`${what}: literals no field holds exactly are refused`
						)
						return
					}
					const found = records("Found", q, { at: natural }, ["at"])
					const row = found.row
					assert.equal(row.name, "FoundRow", what)
					const fields: Readonly<Record<string, Columned<unknown> | undefined>> = row.fields
					const stored = cell.kind === "union" ? [...cell.columns, literalKey] : cell.columns
					assert.deepEqual<ReadonlyArray<string>>(
						Arr.sort(Rcd.keys(fields), Str.Order),
						Arr.sort(["at", ...stored], Str.Order),
						`${what}: the root's fields`
					)
					assert.deepEqual<ReadonlyArray<string>>(row.primaryKey, ["at"], `${what}: the root's key`)
					const forms = formColumns(q.rows.form)
					for (const column of stored) {
						const field = defined(fields[column], `${what}: the stored ${column}`)
						assert.deepEqual(
							columnForm(field.column),
							defined(forms.get(column), `${what}: the query's ${column}`),
							`${what}: ${column}'s column is the query's`
						)
					}
					for (const column of cell.columns) {
						assert.deepEqual(
							declaration(fields[column], column),
							declaration(Item.fields[column], column),
							`${what}: ${column} is stored as its own field`
						)
					}
					if (cell.kind === "union") {
						assert.ok(
							holdsExactly(declaration(fields[literalKey], literalKey), cell.literals),
							`${what}: the literals' column holds exactly its literals`
						)
					} else {
						assert.ok(!Rcd.has(fields, literalKey), `${what}: a head literal is stored nowhere`)
					}
					const level = schema.extend([Rec], "Den", found.relations, found.rules)
					const read = recordsQuery(level, found)
					assert.ok(read.rows.form === q.rows.form, `${what}: the read's decoder is the query's`)
					const program = programOf(read, level)
					for (const layouts of program.layouts) {
						const [first, ...rest] = layouts
						const bound = bindGroups(read.rows, [first, ...rest], program.bind)
						assert.ok(bound.ok, `${what}: the query's decoder binds its read's program`)
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the relation the query reads: each stored field's declaration its own field's, its column the query's decoder's"
			},
			box: "each column of a relation of every stored type alone, every column, and every column beside a head literal of each JavaScript type",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/literals.ts",
					original: "\t\t\t\tseq([start, new RegexBuilder().alt(texts.map(literal)), end]),",
					replacement:
						"\t\t\t\tseq([start, new RegexBuilder().alt(texts.slice(0, 1).map(literal)), end]),",
					why: "A union's text literals are stored as a text of the first literal's pattern alone, which refuses the second: the column does not hold exactly its literals."
				},
				{
					file: "packages/engine/src/program/records.ts",
					original: "\t\treturn others.length === 0",
					replacement: "\t\treturn others.length >= 0",
					why: "Head literals of several values are taken as one literal, the first, stored nowhere: the union's `lit` is no column of the root, and its read writes the first literal for every row."
				},
				{
					file: "packages/engine/src/program/records.ts",
					original:
						"\t\tfield: defineField({}, typing.carrier.sql, desc.value, { column }, builderLoc(at, []), env)",
					replacement:
						'\t\tfield: defineField({}, typing.carrier.sql, desc.value.kind === "contract" ? desc.value.base : desc.value, { column }, builderLoc(at, []), env)',
					why: "A contract column is stored as its base type, losing its brand and check: account and cents are no longer their own fields."
				},
				{
					file: "packages/engine/src/program/records.ts",
					original: '\tif (carrier?.column.kind === "constant") {',
					replacement:
						'\tif (carrier?.column.kind === "constant" && carrier.column.values.length > 1) {',
					why: "A head literal of one value is read as a column, whose heading typing is untyped: records refuses every query beside a head literal."
				},
				{
					file: "packages/engine/src/program/records.ts",
					original: "\t\t\t...state.literals\n",
					replacement: "\n",
					why: "The read finds no head literal, so the query's decoder, which reads `lit`, does not bind the read's program."
				}
			]
		}
	)
