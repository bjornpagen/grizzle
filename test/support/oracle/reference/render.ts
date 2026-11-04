import { Array as Arr, Effect } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { moneyMinorUnits } from "#compiler/ir/carriers.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import { cast, lit, namedType, numericType, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import type { Run, StatementRows } from "#test/support/oracle/compare.ts"
import {
	captureRows,
	type QueryRunner,
	type RawCaptureError,
	type RawRow
} from "#test/support/oracle/install/capture.ts"
import { moneyText } from "#test/support/oracle/install/literal.ts"
import type { InstallPlan } from "#test/support/oracle/install/model.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import type { ExpectedStatement } from "#test/support/oracle/reference/deliver.ts"
import {
	literalOfValue,
	referenceUnsupported,
	Declined,
	type Value
} from "#test/support/oracle/reference/values.ts"
import type { SqlError } from "#test/support/pg.ts"
import { testTypeSchema } from "#test/support/sql.ts"

/**
 * The PostgreSQL type a value of `type` is spelled at: its base, with its numeric typmod, an enum as the installed
 * type of its roster, an exact value as the lowering types it (bigint for an exact integer of at most 18 digits,
 * numeric otherwise).
 */
const sqlTypeOf = (type: ScalarType, plan: InstallPlan): TypeRef => {
	const b = baseOf(type)
	switch (b.carrier) {
		case "int2":
			return types.smallint
		case "int4":
			return types.integer
		case "int8":
			return types.bigint
		case "numeric":
			return b.typmod === undefined
				? types.numeric
				: numericType(b.typmod.precision, b.typmod.scale)
		case "float4":
			return types.real
		case "float8":
			return types.double
		case "money":
			return types.money
		case "bool":
			return types.boolean
		case "uuid":
			return types.uuid
		case "text":
			return types.text
		case "enum": {
			const closed = b.roster.closed
			const e = plan.enums[closed]
			if (e === undefined) {
				throw referenceUnsupported(`the installed enum of ${closed}`)
			}
			return namedType(testTypeSchema(e.name.schema), e.name.name, [])
		}
		case "range4":
			return types.int4range
		case "range8":
			return types.int8range
		case "vector":
			return namedType(testTypeSchema(plan.vectorSchema), "vector", [b.typmod.dims])
		case "exactInteger":
			return b.digits <= 18 ? types.bigint : types.numeric
		case "exactMoney":
			return types.numeric
	}
}

/**
 * One typed SQL literal of a value.
 *
 * Money from its exact amount, never a currency-formatted string.
 *
 * A span as its range type's input text, half-open.
 *
 * A vector as its canonical text, which pgvector's input reads exactly.
 */
const valueExpr = (literal: TypedLiteral, type: TypeRef): Expr => {
	switch (literal.kind) {
		case "int":
			return lit.int(literal.value, type)
		case "numeric":
			return lit.decimal(decimalPayload(literal.value), type)
		case "float":
			return lit.float(literal.value, type)
		case "floatSpecial":
			return lit.float(
				literal.value === "NaN"
					? Number.NaN
					: literal.value === "Infinity"
						? Number.POSITIVE_INFINITY
						: Number.NEGATIVE_INFINITY,
				type
			)
		case "money":
			return cast(lit.decimal(moneyText(moneyMinorUnits(literal.value)), types.numeric), type)
		case "bool":
			return literal.value ? lit.bool(true) : lit.bool(false)
		case "text":
		case "uuid":
			return lit.text(literal.value, type)
		case "enum":
			return lit.text(literal.handle, type)
		case "span":
			return lit.text(`[${literal.start},${literal.end})`, type)
		case "vector":
			return lit.text(literal.value[canonicalTag]().payload, type)
	}
}

/** The most columns one rendering query selects; PostgreSQL allows 1664 target entries. */
const columnsPerQuery = 1000

/**
 * The reference's rows as raw text: each value spelled by its PostgreSQL type's own output function.
 *
 * The oracle compares raw text, the bytes a type's output function writes, so the reference's values must become the
 * same text PostgreSQL would write for them. Rather than reimplement float8out, cash_out and numeric_out on the host,
 * the reference asks PostgreSQL: every distinct value becomes one typed literal of its type (an integer, an exact
 * decimal with its display scale, a double in shortest round-trip form, money from its exact amount, an enum label, a
 * vector's canonical text),
 * all of them selected in one row, and capture (install/capture.ts) reads each column's output text. Input and output
 * functions round-trip every value the reference holds exactly, so the text is the value's, and the reference's
 * meaning stays the host's own.
 *
 * The expected statements as a run of raw text rows, spelled by PostgreSQL on `runner`.
 */
export const renderExpected = (
	runner: QueryRunner,
	plan: InstallPlan,
	statements: ReadonlyArray<ExpectedStatement>
): Effect.Effect<Run, SqlError | RawCaptureError> =>
	Effect.gen(function* () {
		const slots = new Map<string, number>()
		const exprs: Array<string> = []
		const slotOf = (v: Value, type: ScalarType): number => {
			const sql = printExpr(valueExpr(literalOfValue(v, type), sqlTypeOf(type, plan)))
			let slot = slots.get(sql)
			if (slot === undefined) {
				slot = exprs.length
				exprs.push(sql)
				slots.set(sql, slot)
			}
			return slot
		}
		/**
		 * A declined term's cell (values.ts Declined) is rendered as no value's text: the comparison reads its column's
		 * type alone, and each row stating every column (compare.ts).
		 */
		const indexed = Arr.map(statements, (s) =>
			Arr.map(s.rows, (row) =>
				Arr.map(row, (v, i): number | "unstated" => {
					const column = s.heading[i]
					if (column === undefined) {
						throw new Error(`${s.label}: a row wider than its heading`)
					}
					return v instanceof Declined ? "unstated" : slotOf(v, column.type)
				})
			)
		)
		const texts: Array<string> = []
		for (let start = 0; start < exprs.length; start += columnsPerQuery) {
			const chunk = exprs.slice(start, start + columnsPerQuery)
			const [row] = yield* captureRows(runner, `SELECT ${Arr.join(chunk, ", ")}`, [], {
				columns: chunk.length
			})
			appendAll(texts, row ?? [])
		}
		const textAt = (slot: number): string => {
			const text = texts[slot]
			if (text === undefined) {
				throw new Error(`no rendered text for slot ${slot}`)
			}
			return text
		}
		/** A row's text, an unstated cell shown in a report as such. */
		const textOf = (row: ReadonlyArray<number | "unstated">): RawRow =>
			Arr.map(row, (slot) => (slot === "unstated" ? "(unstated)" : textAt(slot)))
		return {
			name: "reference",
			statements: Arr.map(statements, (s, i): StatementRows => {
				const rows = elementAt(indexed, i, "the rendered statements")
				const declined = Arr.flatMap(s.heading, (column, j) =>
					Arr.some(rows, (row) => row[j] === "unstated") ? [column] : []
				)
				return {
					label: s.label,
					columns: Arr.map(s.heading, (c) => c.name),
					types: Arr.map(s.heading, (c) => c.type),
					unstated:
						declined.length > 0
							? {
									kind: "some",
									columns: Arr.map(declined, (c) => c.name),
									complete: Arr.flatMap(rows, (row, r) =>
										Arr.every(row, (slot) => slot !== "unstated") ? [r] : []
									)
								}
							: { kind: "none" },
					rows: Arr.map(rows, textOf)
				}
			})
		}
	})
