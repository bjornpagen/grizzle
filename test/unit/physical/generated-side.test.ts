import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import type { ColumnDef } from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import {
	generationReads,
	nameOf,
	type Reading,
	schemaOf,
	sideCaseGen
} from "#test/unit/physical/generated-side.fixtures.ts"

/** A law column over a generated field reads the row's written fields alone, never a generated column. Its budget is its suite's before it was a property (test/unit/physical/generated-side.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const aLawColumnOverAGeneratedFieldReadsTheRowsWrittenFieldsAloneNeverAGeneratedColumn =
	property.explore(sideCaseGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"a term over a generated field",
			"a selection over a generated field",
			["a term over a generated field", "a selection over a generated field"],
			"a key over a generated read",
			["a key over a generated read", "a term over a generated field"],
			["a key over a generated read", "a selection over a generated field"],
			"a containment over a generated read",
			["a containment over a generated read", "a term over a generated field"],
			["a containment over a generated read", "a selection over a generated field"],
			"a key over written fields"
		] satisfies ReadonlyArray<Reached<Reading>>,
		check: (_, k: Case<Reading>) => (c) =>
			Effect.sync(() => {
				const term = Arr.some(c.terms, (t) => t.kind === "generated")
				const selection = c.selection.kind === "generated"
				if (term) {
					k.note("a term over a generated field")
				}
				if (selection) {
					k.note("a selection over a generated field")
				}
				if (term && selection) {
					k.pair("a term over a generated field", "a selection over a generated field")
				}
				const { R, value } = schemaOf(c)
				const owned = owning(value)
				const compiled = compileInstallation(owned, installOptions(owned))
				const generatedReads = Arr.flatMap([...c.terms, c.selection], (ref) =>
					ref.kind === "generated" ? [nameOf(ref)] : []
				)
				const law: Reading =
					c.law === "contained"
						? "a containment over a generated read"
						: generatedReads.length > 0
							? "a key over a generated read"
							: "a key over written fields"
				k.note(law)
				if (law !== "a key over written fields" && term) {
					k.pair(law, "a term over a generated field")
				}
				if (law !== "a key over written fields" && selection) {
					k.pair(law, "a selection over a generated field")
				}
				const installation = succeeded(compiled, "the installation compiles")
				const names = installationNamesOf(installation)
				const columns = Arr.flatMap(installation.statements, (s): ReadonlyArray<ColumnDef> =>
					s.kind === "createTable"
						? s.columns
						: s.kind === "alterTable"
							? Arr.flatMap(s.actions, (a) => (a.kind === "addColumn" ? [a.column] : []))
							: []
				)
				const generatedColumns = new Set(
					Arr.flatMap(columns, (col) => (generationReads(col).length > 0 ? [col.name] : []))
				)
				for (const at of indices(c.generated.length)) {
					assert.ok(generatedColumns.has(names.columnIdent(R, `v${at}`)), `v${at} is generated`)
				}
				assert.ok(generatedColumns.size > c.generated.length, "the selected side adds a law column")
				for (const col of columns) {
					for (const read of generationReads(col)) {
						assert.ok(
							!generatedColumns.has(read),
							`${col.name}'s generation reads the generated column ${read}`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's generated columns: a generation expression reads no generated column"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/tables.ts",
				original: "\tconst expr = lowerWrittenRow(b, o.relation, value.term, label)",
				replacement: "\tconst expr = lowerRow(b, o.relation, value.term, label)",
				why: "A law column's generation term reads a generated field's column where it should read that field's own generation."
			}
		]
	})
