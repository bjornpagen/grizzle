/** What the properties of generated-side.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { int4, int8 } from "#compiler/public/fields.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import {
	generatedField,
	generatedRelation,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
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
import { regex } from "#test/support/unit/schema/support.ts"

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
 * adds, which every case's installation compiles.
 *
 * Features: a term and a selection over a generated field, alone and together, under a key or a containment over a
 * generated read, and a key over written fields.
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

export const nameOf = (ref: FieldRef): string =>
	ref.kind === "written" ? `w${ref.at}` : `v${ref.at}`

export const sideCaseGen: Gen<SideCase> = (source) => {
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
export const schemaOf = (c: SideCase) => {
	const R = generatedRelation(
		"R",
		{
			id: int4,
			...Rec.fromEntries(Arr.map(indices(c.written), (at) => [`w${at}`, Numeral] as const))
		},
		["id"],
		(r: Readonly<Record<string, unknown>>) =>
			Rec.fromEntries(
				Arr.map(c.generated, (w, at) => [
					`v${at}`,
					generatedField(int8, computeCore.cast(r[`w${w}`], int8), [])
				])
			),
		[]
	)
	const selected = selectBuilder(R, (t: Readonly<Record<string, unknown>>) =>
		c.selection.kind === "written"
			? computeCore.matches(t[nameOf(c.selection)], computeCore.pattern("^0*1"))
			: rowHelpers.gt(t[nameOf(c.selection)], 9n)
	)
	const side = onBuilder(selected, Arr.map(c.terms, nameOf))
	if (c.law === "key") {
		return { R, value: schema("Generated", [R], [keyBuilder(side)], []) }
	}
	const targets = Arr.map(c.terms, (_, i) => `t${i}`)
	const targetFields: Readonly<Record<string, FieldBase>> = Rec.fromEntries(
		Arr.map(c.terms, (t, i) => [`t${i}`, t.kind === "written" ? Numeral : int8] as const)
	)
	const T = relation("T", targetFields, nonEmpty(targets, "T's key"), [])
	return {
		R,
		value: schema("Generated", [R, T], [containedBuilder(side, onBuilder(T, targets))], [])
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

/** The columns a column's generation reads: none for a column with none. */
export const generationReads = (c: ColumnDef): ReadonlyArray<string> => {
	const g = c.generated
	if (g === undefined) {
		return []
	}
	return g.kind === "stored"
		? columnsRead(g.expr)
		: [...columnsRead(g.when), ...columnsRead(g.expr)]
}

export type Reading =
	| "a term over a generated field"
	| "a selection over a generated field"
	| "a key over a generated read"
	| "a containment over a generated read"
	| "a key over written fields"
