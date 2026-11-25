/**
 * What the property of records.test.ts reads: a records over each drawn shape of a query over Shelves (test/support/
 * agreement/records.ts), at a level over it that lists the records, and a login over that level whose workload reads
 * them back, so its programs read the records' relations; the login's served file as generate compiles it with no
 * database, its text read back as an import of it yields it (served/json.ts servedFile), served; and a found row of each
 * heading the query delivers, drawn off its decoder form.
 */

import { defined } from "@bjornpagen/testing/assert"
import type { Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { rowOptions, toResult } from "#adapter/engine.ts"
import { served } from "#adapter/public/layer.ts"
import { type Recorded, recordedOf } from "#adapter/public/records.ts"
import { type DecoderForm, type FieldForm, formFields } from "#compiler/core/decoder.ts"
import { frozenRecordOf } from "#compiler/core/record.ts"
import { rowTextOver } from "#compiler/program/text.ts"
import { workload } from "#compiler/program/workload/value.ts"
import {
	login,
	records,
	recordsFacts,
	recordsQuery,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { conversionSpec } from "#compiler/scalar/values/convert.ts"
import type { ServedFile } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { AnyRecords } from "#compiler/types/schema/records.ts"
import {
	ownerOf,
	type RecordsShape,
	shapeGen,
	shapeQuery
} from "#test/support/agreement/records.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { shelvesNamed } from "#test/support/fixtures/records/shelves.ts"
import { Id } from "#test/support/ids.ts"

export const recordsShapeGen: Gen<RecordsShape> = shapeGen

/** A relation beside the records that no program of the login reads: its records the served file carries none of. */
const Aside = (base: ReturnType<typeof shelvesNamed>) =>
	records(
		"Aside",
		shapeQuery(base, {
			owner: "run",
			books: {
				name: "books",
				descending: false,
				at: false,
				literal: false,
				blurb: Option.none(),
				spine: Option.none(),
				paper: Option.none(),
				digital: Option.none(),
				chapters: Option.none()
			}
		}),
		{ run: Id },
		["run"]
	)

/**
 * The records of `shape` over Shelves, `Kept`, and an aside the login reads nothing of, listed by a level over Shelves,
 * and a login over that level whose one role reads Kept back (recordsQuery): Kept's relations are its programs'.
 */
const builtOf = (shape: RecordsShape) => {
	const base = shelvesNamed("Shelves")
	const query = shapeQuery(base, shape)
	const owner = ownerOf(shape)
	const kept = records("Kept", query, owner.fields, owner.key)
	const aside = Aside(base)
	const level = schema.extend(
		[base],
		"ShelvesKept",
		[...kept.relations, ...aside.relations],
		[...kept.rules, ...aside.rules]
	)
	const keeper = role(level, "keeper", wholeEntriesOf(level))
	const keeping = login(level, "keeping", [keeper], {
		workload: [workload(keeper, { back: recordsQuery(keeper, kept) })]
	})
	return { level, query, kept, keeping }
}

/** The least value of each carrier a records' query over Shelves stores: its integers' and its ids'. */
const leastOf: ReadonlyMap<string, unknown> = new Map<string, unknown>([
	["int2", 1],
	["int4", 1],
	["int8", 1n],
	["uuid", Id("00000000-0000-4000-8000-000000000001")]
])

/** A value of a column of `form`'s first heading: the least of its carrier, the first handle of its roster. */
const columnValue = (
	field: Extract<FieldForm, { readonly kind: "column" }>,
	handles: (roster: string) => ReadonlyArray<string>
): unknown => {
	const column = field.column
	switch (column.kind) {
		case "code":
			return defined(handles(column.roster)[0], `a handle of ${column.roster}`)
		case "bits":
			return new Set(handles(column.roster).slice(0, 1))
		case "text":
			return "a"
		case "bytes":
			throw new Error("a records' query over Shelves stores no bytes")
		case "constant":
			return column.values[0]
		case "convert": {
			const { carrier } = conversionSpec(column.conversion)
			return defined(
				leastOf.get(carrier),
				`the least value of a ${carrier}, a carrier a records' query over Shelves stores`
			)
		}
	}
}

/** A row of `form`'s first heading: each column its least value, each attachment, Option and arm one child. */
const rowOf = (form: DecoderForm, handles: (roster: string) => ReadonlyArray<string>): unknown => {
	const [heading] = formFields(form)
	return frozenRecordOf(
		Arr.map(defined(heading, "a heading the query delivers"), ([key, field]) => {
			switch (field.kind) {
				case "column":
					return [key, columnValue(field, handles)] as const
				case "attachment":
					switch (field.delivery) {
						case "array":
							return [key, Object.freeze([rowOf(field.child, handles)])] as const
						case "option":
							return [key, Option.some(rowOf(field.child, handles))] as const
						case "one":
							return [key, rowOf(field.child, handles)] as const
					}
				case "some":
				case "arm":
					return [key, Option.some(rowOf(field.child, handles))] as const
				case "none":
					return [key, Option.none()] as const
			}
		})
	)
}

/** The served file's records of a case, its text read back, and what each reads of a drawn row. */
export const recordsCase = (shape: RecordsShape) => {
	const built = builtOf(shape)
	const compiled = compiledServedFile(built.keeping)
	const file: ServedFile = succeeded(servedFile(compiled), "the served file read back")
	const keeping = served<typeof built.keeping>(compiled, "keeping")
	const kept = file.records.get("Kept")
	const recorded: Recorded<typeof built.level, AnyRecords> = recordedOf(keeping, "Kept")
	const handles = (roster: string): ReadonlyArray<string> =>
		defined(kept?.rosters.get(roster), `the served roster ${roster}`).handles
	const row = rowOf(built.kept.rows.form, handles)
	const run = Id("00000000-0000-4000-8000-0000000000aa")
	const owner = shape.owner === "run" ? { run } : { run, step: 1 }
	const queryText = succeeded(rowTextOver(built.query, toResult, rowOptions))
	return {
		carried: [...file.records.keys()],
		form: { served: kept?.form, query: built.kept.rows.form },
		text: { served: recorded.text(row), query: queryText(row) },
		facts: {
			served: recorded.facts([[owner, row]]),
			query: recordsFacts(built.level, built.kept)([[owner, row]])
		},
		aside: () => recordedOf(keeping, "Aside")
	}
}
