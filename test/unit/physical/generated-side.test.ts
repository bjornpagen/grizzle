import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { generatedField, generatedRelation, relation } from "#compiler/schema/relation.ts"
import { schema } from "#compiler/schema/schema.ts"
import {
	containedBuilder,
	keyBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import { rowHelpers } from "#compiler/schema/terms.ts"
import type { ColumnDef, Expr } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { regex } from "#test/unit/schema/support.ts"

/**
 * A law column over a generated field reads what the field is generated from: PostgreSQL refuses a generation
 * expression that reads a generated column (42P17), so a law over a selected side whose terms or selection read a
 * generated field installs only when its law column's generation reads the row's written fields alone. A key over such
 * a side installs as a containment from it does: the statement that writes a row compares it at the generated field's
 * generation expression (test/pg/write/generated-key).
 *
 * Each case draws a relation of one to three written numerals and up to two bigint fields generated from drawn ones of
 * them, and a key over a selected side, or a containment from one into a relation keyed by fields of its terms' types,
 * whose one or two terms and whose selection each read a drawn field, written or generated. Oracle: PostgreSQL's rule
 * for generated columns, that a generation expression reads no generated column, over every column the installation
 * adds, which every case's installation compiles. test/pg/compute/translate.test.ts installs one and writes it.
 */
type FieldRef =
	| { readonly kind: "written"; readonly at: number }
	| { readonly kind: "generated"; readonly at: number }

interface SideCase {
	readonly written: number
	/** The written numeral each generated field casts. */
	readonly generated: ReadonlyArray<number>
	readonly terms: Arr.NonEmptyReadonlyArray<FieldRef>
	readonly selection: FieldRef
	readonly law: "key" | "contained"
}

const nameOf = (ref: FieldRef): string => (ref.kind === "written" ? `w${ref.at}` : `v${ref.at}`)

const sideCaseGen: Gen<SideCase> = (source) => {
	const written = source.draw(int(1, 3))
	const generated = source.draw(array(int(0, written - 1), { min: 0, max: 2 }))
	const refs = nonEmpty(
		[
			...Arr.map(indices(written), (at): FieldRef => ({ kind: "written", at })),
			...Arr.map(indices(generated.length), (at): FieldRef => ({ kind: "generated", at }))
		],
		"the fields"
	)
	return {
		written,
		generated,
		terms: nonEmpty(
			source.draw(shuffled(refs, { min: 1, max: Math.min(2, refs.length) })),
			"the key's terms"
		),
		selection: Arr.getUnsafe(refs, source.draw(int(0, refs.length - 1))),
		law: source.draw(boolean) ? "contained" : "key"
	}
}

const Numeral = regex("^[0-9]{1,6}$", "u")

/** The relation a case draws and its schema, built as a JavaScript caller builds them. */
const schemaOf = (c: SideCase) => {
	const R = generatedRelation(
		"R",
		{
			id: pg.integer,
			...Rec.fromEntries(Arr.map(indices(c.written), (at) => [`w${at}`, Numeral] as const))
		},
		["id"],
		(r: Readonly<Record<string, unknown>>) =>
			Rec.fromEntries(
				Arr.map(c.generated, (w, at) => [
					`v${at}`,
					generatedField(pg.bigint, computeCore.cast(r[`w${w}`], pg.bigint), [])
				])
			),
		[]
	)
	const selected = selectBuilder(R, (t: Readonly<Record<string, unknown>>) =>
		c.selection.kind === "written"
			? computeCore.matches(t[nameOf(c.selection)], "^0*1")
			: rowHelpers.gt(t[nameOf(c.selection)], 9n)
	)
	const side = onBuilder(selected, Arr.map(c.terms, nameOf))
	if (c.law === "key") {
		return { R, value: schema("Generated", { R }, [keyBuilder(side)], []) }
	}
	const targets = Arr.map(c.terms, (_, i) => `t${i}`)
	const targetFields: Readonly<Record<string, FieldBase>> = Rec.fromEntries(
		Arr.map(c.terms, (t, i) => [`t${i}`, t.kind === "written" ? Numeral : pg.bigint] as const)
	)
	const T = relation("T", targetFields, nonEmpty(targets, "T's key"), [])
	return {
		R,
		value: schema("Generated", { R, T }, [containedBuilder(side, onBuilder(T, targets))], [])
	}
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

type Reading =
	| "a term over a generated field"
	| "a selection over a generated field"
	| "a key over a generated read"
	| "a containment over a generated read"
	| "a key over written fields"

describe("a law column over a generated field", () => {
	it.effect("reads the row's written fields alone, never a generated column", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/physical/generated-side",
					draw: drawn(sideCaseGen),
					literal: Formatter.format,
					oracle: {
						kind: "specification",
						name: "PostgreSQL's generated columns: a generation expression reads no generated column"
					},
					coverage: required<Reading>(
						[
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
						],
						{ cases: 60, sense: notesOnly }
					),
					kept: [],
					runs: 60,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
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
						const compiled = compileInstallation(owned, installOptions(owned, "grizzle_dev"))
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
						assert.ok(
							generatedColumns.size > c.generated.length,
							"the selected side adds a law column"
						)
						for (const col of columns) {
							for (const read of generationReads(col)) {
								assert.ok(
									!generatedColumns.has(read),
									`${col.name}'s generation reads the generated column ${read}`
								)
							}
						}
					})
			)
		)
	)
})
