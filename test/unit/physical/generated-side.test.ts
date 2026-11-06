import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated, pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ColumnDef, Expr } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"

/**
 * A law column over a generated field reads what the field is generated from: PostgreSQL refuses a generation
 * expression that reads a generated column (42P17), so a key over a selected side whose term or selection reads a
 * generated field installs only when its law column's generation reads the row's written fields alone. Over a box of
 * the two ways a law column reads a generated field, every generated column the installation adds reads no column
 * the installation generates; test/pg/compute/translate.test.ts installs one and writes it.
 */

/** Where a selected side's law column reads a generated field: its term, or its selection. */
type Reading = "a term over a generated field" | "a selection over a generated field"

const readings: Arr.NonEmptyReadonlyArray<Reading> = [
	"a term over a generated field",
	"a selection over a generated field"
]

const Numeral = str.regex("^[0-9]{1,6}$", "u")

/** A relation whose v is generated from its numeral k, and the key a reading states over a selected side. */
const schemaOf = (reading: Reading) => {
	const R = relation.generated("R", { id: pg.integer, g: pg.integer, k: Numeral }, ["id"], (r) => ({
		v: generated(pg.bigint, Compute.cast(r.k, pg.bigint))
	}))
	const statement =
		reading === "a term over a generated field"
			? key(
					on(
						select(R, (t) => Compute.matches(t.k, "^0*1")),
						"g",
						"v"
					)
				)
			: key(
					on(
						select(R, (t) => t.gt(t.v, 9n)),
						"g",
						"k"
					)
				)
	return { R, value: schema("Generated", { R }, [statement]) }
}

/** The column names an expression reads. */
const columnsRead = (e: Expr): ReadonlyArray<string> => {
	const read: Array<string> = []
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column") {
				read.push(x.column)
			}
			return x
		}
	})
	return read
}

/** The columns a column's generation reads: none for a column with none, an identity among them. */
const generationReads = (c: ColumnDef): ReadonlyArray<string> => {
	const g = c.generated
	if (g === undefined || g.kind === "identity") {
		return []
	}
	return g.kind === "stored"
		? columnsRead(g.expr)
		: [...columnsRead(g.when), ...columnsRead(g.expr)]
}

describe("a law column over a generated field", () => {
	it.effect("reads the row's written fields alone, never a generated column", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/physical/generated-side",
					generator: element(readings),
					literal: Formatter.format,
					limit: readings.length,
					box: "a key over a selected side whose term or whose selection reads a generated field",
					oracle: {
						kind: "specification",
						name: "PostgreSQL's generated columns: a generation expression reads no generated column"
					},
					coverage: requiredInSpace<Reading>(readings),
					caseHang
				},
				(reading, k) =>
					Effect.sync(() => {
						k.note(reading)
						const { R, value } = schemaOf(reading)
						const owned = owning(value)
						const installation = succeeded(
							compileInstallation(owned, installOptions(owned, "grizzle_dev")),
							"the installation compiles"
						)
						const names = installationNamesOf(installation)
						const columns = Arr.flatMap(installation.statements, (s): ReadonlyArray<ColumnDef> =>
							s.kind === "createTable"
								? s.columns
								: s.kind === "alterTable"
									? Arr.flatMap(s.actions, (a) => (a.kind === "addColumn" ? [a.column] : []))
									: []
						)
						const generatedColumns = new Set(
							Arr.flatMap(columns, (c) => (generationReads(c).length > 0 ? [c.name] : []))
						)
						assert.ok(generatedColumns.has(names.columnIdent(R, "v")), "v is generated")
						assert.ok(generatedColumns.size > 1, "the key adds law columns")
						for (const c of columns) {
							for (const read of generationReads(c)) {
								assert.ok(
									!generatedColumns.has(read),
									`${c.name}'s generation reads the generated column ${read}`
								)
							}
						}
					})
			)
		)
	)
})
