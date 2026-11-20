/**
 * A declared function's headings and arguments install in their names' code point order, whatever order their records
 * write their keys in: a heading's fields are its row type's attributes and a function's arguments its parameters, both
 * of which PostgreSQL reads by position, so an order taken from a record's keys moves a hand-written body's values
 * where oxlint's sort-keys reorders the record.
 *
 * - **Property:** a case draws an order of the keys of every record the declarations of key-order.fixtures.ts write
 *   (QTI's single value as edullm's grading declares it, a heading of names whose code point order is neither their
 *   UTF-16 units' nor a case-folded one, a heading holding both, the arguments of kernelSin(iy, x, y), of pick and of
 *   wrap) and of every call of them a program writes (Fn.call, Fn.rows, Fn.row). Its installation's
 *   statements, printed, and its login's served file, its programs' SQL among it, are byte for byte those of every
 *   record written in its names' order; and each row type's attributes and each function's parameters stand in their
 *   names' code point order.
 * - **Oracle:** the declarations written in sort-keys' order, compiled by the same compiler, and code point order
 *   restated from the names' code points (test/support/key-order.ts).
 * - **Features:** a heading, an argument list and a call's arguments written out of their names' order, and every
 *   record written in it.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { installedOrder } from "#test/support/key-order.ts"
import {
	featuresOf,
	type KeyOrderFeature,
	keyOrdersGen,
	madeIn,
	sortedOrders
} from "#test/unit/schema/key-order.fixtures.ts"

const features = [
	"a heading written out of its names' order",
	"an argument list written out of its names' order",
	"a call's arguments written out of their names' order",
	"every record written in its names' order"
] as const satisfies ReadonlyArray<Reached<KeyOrderFeature>>

/** The declarations written in sort-keys' order, made once: what every case is held to. */
const sorted = Effect.runSync(madeIn(sortedOrders))

/** A heading's or a function's record written in any key order installs and serves what its sorted writing does. */
export const aDeclaredFunctionsHeadingsAndArgumentsInstallInTheirNamesCodePointOrderWhateverOrderTheirRecordsWrite =
	property.explore(keyOrdersGen, {
		needs: {},
		situations: features,
		budget: { runs: 24, steered: features.length },
		check: (_, notes: Case<KeyOrderFeature>) => (o) =>
			Effect.gen(function* () {
				for (const feature of featuresOf(o)) {
					notes.note(feature)
				}
				const made = yield* madeIn(o)
				for (const names of made.installedNames) {
					assert.deepEqual(
						names,
						installedOrder(names),
						"a row type's attributes or a function's parameters"
					)
				}
				assert.deepEqual(made.statements, sorted.statements, "the installation's statements")
				assert.equal(made.served, sorted.served, "the login's served file")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the declarations written in sort-keys' order, and code point order restated from the names' code points"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/function.ts",
				original: "\tconst heading = byName(fields).map(",
				replacement: "\tconst heading = Object.entries(fields).map(",
				why: "A heading's attributes install in its record's key order, so a heading written in another order is another row type, and a body's ROW(...) moves its values."
			},
			{
				file: "packages/engine/src/schema/function.ts",
				original: "\t\t\tbyName(args).map(([arg, type]) => ({",
				replacement: "\t\t\tObject.entries(args).map(([arg, type]) => ({",
				why: "A function's parameters install in its args' key order, so a body's positional call or $1 passes another argument."
			},
			{
				file: "packages/engine/src/schema/function.ts",
				original: "\tObject.entries(record).toSorted(([a], [b]) => compareCodePoints(a, b))",
				replacement:
					"\tObject.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))",
				why: "Names sort by UTF-16 code unit, which puts U+10000 before U+E000, an order sort-keys never writes, so a sorted record's source no longer shows its installed order."
			},
			{
				file: "packages/engine/src/schema/function.ts",
				original:
					'\t\tvalue: { ...builtMark, kind: "rows", fields: frozenCopy(nameOrdered(fields)) },',
				replacement: '\t\tvalue: { ...builtMark, kind: "rows", fields: frozenCopy(fields) },',
				why: "A heading's record keeps the order its keys were written in, so the variables a query reads off a call of it come in that order, and its served programs change with it."
			}
		]
	})
