/** What the properties of refusal.test.ts read: its spaces, models and helpers. */

import { codePoint, element, type Gen, oneOf, string, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { param, types } from "#compiler/sql/build.ts"
import type { ArmRefusal } from "#compiler/write/refusal.ts"
import { assert } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { wild } from "#test/support/kernel/naming.ts"

/** An error's DETAIL; an error without one fails. */
export const detailOf = (detail: Option.Option<string>): string =>
	Option.match(detail, {
		onNone: () => assert.fail("a refusal without a DETAIL"),
		onSome: (text) => text
	})

/** The key's three fields: a uuid, a bigint and a text. */
const key = [
	{ field: "employee", expr: param(1, types.uuid), type: scalarOf({ kind: "uuid" }, {}) },
	{ field: "week", expr: param(2, types.bigint), type: plainType("int8") },
	{ field: "note", expr: param(3, types.text), type: wildcardText }
] as const

/** The law a refusal names, and the constraint it raises: inputs of the codec under test, stated once and named by no
 * installation. */
const timesheetLaw = wild.lawId("timesheet_pk")

export const constraint = timesheetLaw

export const law: Extract<ArmRefusal, { readonly kind: "law" }> = {
	kind: "law",
	law: timesheetLaw,
	relation: "Timesheet",
	key
}

export const change: Extract<ArmRefusal, { readonly kind: "change" }> = {
	kind: "change",
	reason: "PutTargetConflict",
	relation: "Timesheet",
	constraint,
	key
}

/** A letter with a combining mark after it: one user-perceived character of two scalars. */
const combined: Gen<string> = (source) =>
	`${source.draw(codePoint(0x61, 0x7a))}${source.draw(codePoint(0x03_00, 0x03_6f))}`

/**
 * Texts of up to ten characters PostgreSQL stores: printable ASCII, or any other scalar but NUL and the lone
 * surrogates, or a letter with a combining mark, so room for every delimiter, escape and quote of the DETAIL grammar
 * beside one another.
 */
const storable = string(
	oneOf([codePoint(0x20, 0x7e), codePoint(0x01, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff), combined]),
	{ min: 0, max: 10 }
)

/** One key's texts: the employee's uuid, the week's bigint and the note. */
export interface KeyTexts {
	readonly employee: string
	readonly week: string
	readonly note: string
}

/** The DETAIL grammar's delimiters, escapes and quotes, and the empty text, drawn as notes beside the storable ones. */
const grammarEdges = [
	'"',
	"\\",
	",",
	"]",
	"k[",
	"a[",
	"\n\t\u0001",
	"\u{1F600}",
	"'",
	"$$",
	"é",
	""
] as const

export const note: Gen<string> = weighted([
	[3, storable],
	[1, element(grammarEdges)]
])

/** A refusal the installed function raises: its SQLSTATE and the DETAIL a law's refusal or a concurrent change makes. */
export type Raised = "a law's refusal" | "a concurrent change"

export const raisedFeatures: Arr.NonEmptyReadonlyArray<Raised> = [
	"a law's refusal",
	"a concurrent change"
]
