/**
 * How a statement names a write program's carrier (write/carriers/carriers.ts): the transaction-local settings its
 * columns travel in, and the rows a statement reads of them. A carrier is no object of the session: its name is a
 * setting's, and every statement that reads or fills it reads or writes its settings by that name, as a literal, so the
 * statement's text is its program's alone.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ColumnDef, Expr, FromSource, TypeRef } from "#compiler/sql/ast.ts"
import { arrays, call, cast, lit, types } from "#compiler/sql/build.ts"
import { type CarrierName, carrierName, carrierPrefix } from "#compiler/sql/naming.ts"

/** The namespace of a carrier's settings: grizzle's own custom settings, beside grizzle.claims (sql/print.ts). */
const carrierSettings = "grizzle."

/**
 * The transaction-local setting a carrier's column travels in, `grizzle.<carrier>_<column>`; of a carrier of no
 * column, `grizzle.<carrier>`, its count of rows, 0 or 1, the unit relation's. A carrier's name starts with `__`, so no
 * setting of a carrier is grizzle.claims.
 */
export const carrierSetting = (carrier: CarrierName, column: string | undefined): string =>
	`${carrierSettings}${carrier}${column === undefined ? "" : `_${column}`}`

/**
 * The carrier whose setting `setting` is (`carrierSetting`), none for any other: how a reading of a statement finds the
 * carriers it reads and fills, by the settings its current_setting and set_config calls name
 * (test/support/carrier-reads.ts).
 */
export const settingCarrier = (setting: string): CarrierName | undefined => {
	const prefix = `${carrierSettings}${carrierPrefix}`
	if (!setting.startsWith(prefix)) {
		return undefined
	}
	const [ordinal, column, ...rest] = setting.slice(prefix.length).split("_")
	return decimal(ordinal) &&
		rest.length === 0 &&
		(column === undefined || (column.startsWith("c") && decimal(column.slice(1))))
		? carrierName(Number(ordinal))
		: undefined
}

/** Whether `text` is one or more decimal digits. */
const decimal = (text: string | undefined): text is string =>
	text !== undefined && text.length > 0 && Array.from(text).every((c) => c >= "0" && c <= "9")

/**
 * The array type every carrier column is read through: text[], each element its value's own output text, which the
 * reader casts into the column's type (sql/print.ts printSettingRows). An array of any type reads as text[] element by
 * element exactly as its output wrote it, and a text[]'s unnest returns no composite a function scan would expand into
 * its attributes, as an array of a variant's composite would.
 */
const textArray: TypeRef = {
	kind: "builtin",
	name: "text",
	precision: undefined,
	scale: undefined,
	array: true
}

/** The value of a carrier's setting, as the transaction holds it. */
const settingValue = (carrier: CarrierName, column: string | undefined): Expr =>
	call("current_setting", [lit.text(carrierSetting(carrier, column), types.text)])

/**
 * The type each element of a carrier column of `definition` travels as: its own, but a set's bit(n), which travels as
 * bit varying, no array of a bit(n) being a type grizzle names (sql/ast.ts TypeRef), and is read back cast to its
 * bit(n), its one length (sql/print.ts printUnnested).
 */
export const travelling = (definition: ColumnDef): TypeRef => {
	const type = definition.type
	return type.kind === "builtin" && type.name === "bit" ? types.varbit : type
}

/** The array type a carrier column of `definition` travels as: its elements' (`travelling`). */
export const travellingArray = (definition: ColumnDef): TypeRef => {
	const type = travelling(definition)
	switch (type.kind) {
		case "named":
			return { ...type, array: true }
		case "builtin":
			if (type.name === "bit") {
				defect("a set's bit(n) travels as bit varying")
			}
			return type.name === "numeric" && type.precision !== undefined
				? { ...type, array: true }
				: { kind: "builtin", name: type.name, precision: undefined, scale: undefined, array: true }
	}
}

/**
 * The rows of the carrier `carrier`, whose columns are `columns`, as a statement reads them under `alias`: each
 * column's setting read as an array of its type, the arrays unnested in lockstep, one row per index, each column under
 * its own name; of a carrier of no column, one row of no column per row its count holds. The one way a statement reads
 * a carrier.
 */
export const carrierReading = (
	carrier: CarrierName,
	columns: ReadonlyArray<ColumnDef>,
	alias: string
): FromSource => {
	if (!isNonEmpty(columns)) {
		return {
			kind: "function",
			call: call("generate_series", [
				lit.int(1, types.bigint),
				cast(settingValue(carrier, undefined), types.bigint)
			]),
			alias,
			columns: { kind: "named", names: [], ordinality: false },
			lateral: false
		}
	}
	return arrays(
		{
			kind: "setting",
			columns: mapNonEmpty(columns, (c) => ({
				definition: { name: c.name, type: c.type, collation: c.collation },
				array: cast(settingValue(carrier, c.name), textArray)
			}))
		},
		alias
	)
}
