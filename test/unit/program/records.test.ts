/**
 * A query's records (program/records.ts records and recordsQuery) over a box of flat queries: each column of a relation
 * holding a field of every type a column may be stored as, alone; every column; every column beside a head literal of
 * each JavaScript type; every column beside a union's literals; and a column beside a computed numeric. The records'
 * root `FoundRow` holds the owner's field, then one field per column the query finds, each the column's own field, its
 * declaration and its column the query's (the database's instant a stored instant, a generated search document a
 * stored one, both of one declaration, a variant the variant's one declaration, its arm's check with it), a computed
 * numeric stored as numeric within its bound, and no head literal,
 * keyed by the owner's key; and recordsQuery over a level listing the records reads them through the query's own
 * decoder, which binds the read's compiled program in either artifact.
 *
 * Oracle: the relation the query reads, each stored field's declaration its own field's (schema/relation.ts
 * describeDeclared), a computed numeric's the bound its operands' types prove (sumBound), and its column's form the
 * query's decoder's.
 *
 * Features: none; the box is exhausted.
 *
 * recordPaths over drawn trees of attachments, each level one to three children at most four levels deep, their names
 * repeating across levels and parents: the path of every attachment at any depth, each before those under it, and
 * records(...) given a name for each of them names every relation beside the root as stated, deriving none.
 *
 * Oracle: the drawn tree's own paths, read off it in the order attached.
 *
 * The dynamic door's records (public/dynamic.ts records) over the same drawn trees, their stem typed `string` and a
 * run-time record naming every path: every relation named as stated, a level listing them compiles (lawsOf), and every
 * relation and law is what records' builder declares of the same arguments, one Description by semantic identity.
 *
 * Oracle: a second implementation, records' builder of the same arguments, and the names stated.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rcd, String as Str } from "effect"
import { catchCompileError, sameContent } from "#compiler/core/canonical.ts"
import {
	type Columned,
	columnForm,
	type ColumnForm,
	type DecoderForm
} from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { recordsBuilder } from "#compiler/program/records.ts"
import { records as dynamicRecords } from "#compiler/public/dynamic.ts"
import { natural } from "#compiler/public/fields.ts"
import { recordPaths, records, recordsQuery, schema } from "#compiler/public/schema.ts"
import { recordsReader } from "#compiler/runtime/read/record.ts"
import { bindGroups } from "#compiler/schema/record.ts"
import { describeDeclared, relationDescOf } from "#compiler/schema/relation.ts"
import { statementTextsOf } from "#compiler/schema/statements.ts"
import type { GeneratedRecords } from "#compiler/types/schema/records.ts"
import {
	attachmentsGen,
	type Attachments,
	cellQuery,
	depthOf,
	heldExactly,
	holdsExactly,
	Item,
	literalKey,
	pathsOfTree,
	programOf,
	Rec,
	type RecordsCell,
	recordsBox,
	sumBound,
	sumKey,
	treeQuery
} from "#test/support/unit/program/records.fixtures.ts"

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
					const stored =
						cell.kind === "union"
							? [...cell.columns, literalKey]
							: cell.kind === "sum"
								? [...cell.columns, sumKey]
								: cell.columns
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
					if (cell.kind === "sum") {
						assert.deepEqual(
							declaration(fields[sumKey], sumKey),
							{ kind: "computedNumeric", bound: sumBound },
							`${what}: a computed numeric is stored as numeric within its bound`
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
						const bound = bindGroups(read.rows, (form) =>
							recordsReader(form, [first, ...rest], program.bind)
						)
						assert.ok(bound.ok, `${what}: the query's decoder binds its read's program`)
					}
				}),
			oracle: {
				kind: "second-implementation",
				name: "the relation the query reads: each stored field's declaration its own field's, its column the query's decoder's"
			},
			box: "each column of a relation of every stored type alone (the database's instant, a generated search document and a variant of an arm's check among them), every column, every column beside a head literal of each JavaScript type and beside each pair of a union's literals, and a column beside a computed numeric",
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
					file: "packages/engine/src/schema/field-desc.ts",
					original:
						"\tisNumericValue(type) ? Result.ok(numericBoundDesc(type.bound)) : declaredDescOf(type, declared)",
					replacement:
						'\tisNumericValue(type) ? Result.ok({ kind: "pg", type: "numeric" }) : declaredDescOf(type, declared)',
					why: "A computed numeric is stored as numeric of no typmod at numeric's own limits, its bound lost: `total` is no numeric within the bound its operands prove."
				},
				{
					file: "packages/engine/src/schema/field-desc.ts",
					original:
						'\t\tcase "variant":\n\t\t\treturn declaration("variant", type.variant.name, declared.variant(type.variant.name))',
					replacement:
						'\t\tcase "variant": {\n\t\t\tconst found = declared.variant(type.variant.name)\n\t\t\treturn declaration("variant", type.variant.name, found && { ...found, arms: found.arms.map((arm) => ({ ...arm, check: undefined })) })\n\t\t}',
					why: "A variant column is stored as a variant of its own, rebuilt from the column's type with no arm's check: `cell` is no longer Item's field, and the level listing the records is refused DuplicateIdentity, as metis's essay flow's records of qti-pie's QtiValue were."
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
					original: "[...found, ...root.literals]",
					replacement: "[...found]",
					why: "The read finds no head literal, so the query's decoder, which reads `lit`, does not bind the read's program."
				}
			]
		}
	)

/** What a drawn tree of attachments reaches: a path three levels deep, and a name repeated under another parent. */
type PathsFeature = "a path three levels deep" | "a name repeated under another parent"

/**
 * recordPaths lists the path of every attachment of a query at any depth, each before those under it, and records(...)
 * given a name for each of them names every relation beside the root as stated.
 */
export const recordPathsListEveryAttachmentAtAnyDepthAndNameEveryRelationRecordsMake =
	property.explore(attachmentsGen, {
		needs: {},
		situations: [
			"a path three levels deep",
			"a name repeated under another parent"
		] satisfies ReadonlyArray<Reached<PathsFeature>>,
		check: (_, k: Case<PathsFeature>) => (tree: Attachments) =>
			Effect.sync(() => {
				const what = `the paths of ${Formatter.format(tree)}`
				const q = treeQuery(tree)
				const paths = recordPaths(q)
				assert.deepEqual(paths, pathsOfTree(tree, []), what)
				if (depthOf(tree) >= 3) {
					k.note("a path three levels deep")
				}
				const names = Arr.map(paths, (path) => Arr.lastNonEmpty(Str.split(path, ".")))
				if (Arr.dedupe(names).length < names.length) {
					k.note("a name repeated under another parent")
				}
				const stated = Rcd.fromEntries(Arr.map(paths, (path, i) => [path, `Named${i}`] as const))
				const made = recordsBuilder("Paths", q, { at: natural }, ["at"], [{ names: stated }])
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.map(made.relations, (r) => r.name),
					["PathsRow", ...Arr.map(paths, (_, i) => `Named${i}`)],
					`${what}: every relation beside the root named as stated`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the drawn tree's own paths, read off it in the order attached"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/records.ts",
				original: '\t\treturn [at.join("."), ...attachmentPaths(a.child.attached, at)]',
				replacement: '\t\treturn [at.join(".")]',
				why: "The paths stop at the first level: an attachment under another has no path, so its relation is never named by a generator that names each path."
			}
		]
	})

/**
 * The dynamic door's records, their stem typed `string` and a run-time record naming every path, name every relation as
 * stated, list in a level that compiles, and declare every relation and law records' builder declares of the same
 * arguments.
 */
export const theDynamicDoorsRecordsNameEveryRelationAsStatedAndDeclareWhatRecordsBuilderDeclares =
	property.explore(attachmentsGen, {
		needs: {},
		situations: [
			"a path three levels deep",
			"a name repeated under another parent"
		] satisfies ReadonlyArray<Reached<PathsFeature>>,
		check: (_, k: Case<PathsFeature>) => (tree: Attachments) =>
			Effect.sync(() => {
				const what = `the dynamic records of ${Formatter.format(tree)}`
				const q = treeQuery(tree)
				const paths = recordPaths(q)
				if (depthOf(tree) >= 3) {
					k.note("a path three levels deep")
				}
				const last = Arr.map(paths, (path) => Arr.lastNonEmpty(Str.split(path, ".")))
				if (Arr.dedupe(last).length < last.length) {
					k.note("a name repeated under another parent")
				}
				const stem = `Generated${paths.length}`
				const names: Readonly<Record<string, string>> = Rcd.fromEntries(
					Arr.map(paths, (path, i) => [path, `Named${i}`] as const)
				)
				const generated = dynamicRecords(stem, q, { at: natural }, ["at"], { names })
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.map(generated.relations, (r) => r.name),
					[`${stem}Row`, ...Arr.map(paths, (_, i) => `Named${i}`)],
					`${what}: every relation beside the root named as stated`
				)
				lawsOf(schema.extend([Rec], "Den", generated.relations, generated.rules))
				const built: GeneratedRecords = recordsBuilder(
					stem,
					q,
					{ at: natural },
					["at"],
					[{ names }]
				)
				assert.equal(
					generated.relations.length,
					built.relations.length,
					`${what}: as many relations as records' builder makes`
				)
				for (const [door, builder] of Arr.zip(generated.relations, built.relations)) {
					assert.ok(
						sameContent(relationDescOf(door, "door"), relationDescOf(builder, "builder")),
						`${what}: ${door.name} declares what records' builder declares`
					)
				}
				assert.deepEqual(
					Arr.map(generated.rules, statementTextsOf),
					Arr.map(built.rules, statementTextsOf),
					`${what}: every law is records' builder's`
				)
				assert.deepEqual(
					Arr.map(generated.apart, (r) => r.name),
					Arr.map(built.apart, (r) => r.name),
					`${what}: the relations an insert states apart are records' builder's`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "records' builder of the same arguments, one Description by semantic identity, and the names stated"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/public/dynamic.ts",
				original: "\t\t[options, ...extra]",
				replacement: "\t\t[...extra]",
				why: "The door drops its options: the names it is handed are never stated, so every relation's name is derived, none as stated."
			}
		]
	})
