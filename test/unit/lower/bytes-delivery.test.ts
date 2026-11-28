/**
 * A read delivering bytes columns lowers to a statement whose public names stand on its outermost output alone.
 *
 * A bytes column is delivered in chunks (lower/delivery.ts deliveredRows): the statement numbers the read's rows in a
 * derived table, its column list naming each column, and crosses each with the chunks it is cut into. The read's own
 * targets sit inside that derived table, so they carry no public name: the derived table's column list names them,
 * and the public names stand on the outermost output, each on its cell. A read whose head holds no bytes column is
 * delivered whole, its targets the outermost output's own.
 *
 * Each case reads one relation, Item, of an Id key, two bytes fields and a text field, its head a drawn subset of the
 * four, compiled as the test compile compiles a template (test/support/compile.ts compileTemplate), whose lowering
 * audit (checkedLowering, test/support/oracle/verify/sql.ts statementAudit) refuses a nested target of a public name.
 *
 * Oracle: the lowering's own audit, a specification of where a statement's public names stand.
 *
 * Features: no bytes column, one beside none else, one beside a text column, and two.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { bytea } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { decodedQuery } from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"

const Item = relation(
	"Item",
	{ id: Id, blob: bytea, other: bytea, note: str.regex("^.{0,8}$", "su") },
	["id"]
)
const Items = schema("Items", [Item], [])

/** Item's fields, each bytes or not. */
const fields = { id: false, blob: true, other: true, note: false } as const

type Field = keyof typeof fields

/** A head: which of Item's fields the read finds, each drawn on its own. */
const headGen: Gen<ReadonlyArray<Field>> = (source) =>
	Arr.filter(Rec.keys(fields), () => source.draw(boolean))

type BytesFeature =
	| "no bytes column"
	| "a bytes column alone"
	| "a bytes column beside a text column"
	| "two bytes columns"

const featureOf = (head: ReadonlyArray<Field>): BytesFeature => {
	const delivered = Arr.filter(head, (f) => fields[f]).length
	return delivered === 0
		? "no bytes column"
		: delivered === 2
			? "two bytes columns"
			: head.length === 1
				? "a bytes column alone"
				: "a bytes column beside a text column"
}

/** The read of Item finding `head`, each field bound to a variable of its own. */
const readOf = (head: ReadonlyArray<Field>) =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: Arr.map(Rec.keys(fields), (f) => ({ id: f, origin: { relation: "Item", field: f } })),
				matches: [
					{
						source: { kind: "relation", name: "Item" },
						bindings: Rec.fromEntries(
							Arr.map(Rec.keys(fields), (f) => [f, { kind: "var", var: f }] as const)
						)
					}
				],
				where: [],
				head: Rec.fromEntries(Arr.map(head, (f) => [f, { kind: "var", var: f }] as const)),
				interiors: [],
				attach: []
			}
		]
	})

export const aReadDeliveringBytesColumnsLowersToAStatementWhosePublicNamesStandOnItsOutermostOutputAlone =
	property.exhaust(finite(headGen), {
		needs: {},
		situations: [
			"no bytes column",
			"a bytes column alone",
			"a bytes column beside a text column",
			"two bytes columns"
		] satisfies ReadonlyArray<Reached<BytesFeature>>,
		check: (_, c: Case<BytesFeature>) => (head) =>
			Effect.sync(() => {
				succeeded(compileTemplate(readOf(head), Items, testCompile), "the read compiles")
				c.note(featureOf(head))
			}),
		oracle: {
			kind: "specification",
			name: "the lowering's own audit (checkedLowering): a public name on the outermost output alone"
		},
		box: "every subset of Item's four fields, an Id key, two bytes fields and a text field, as the read's head",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/delivery.ts",
				original: "\t\t\t\t...rows.body.targets.map((t) => ({ ...t, alias: undefined })),",
				replacement: "\t\t\t\t...rows.body.targets,",
				why: 'The read\'s targets keep their public names inside the derived table that numbers its rows, as before: the audit refuses a nested target of a public name (`nested column alias "blob" is not a generated c<n>`), and the property fails at every head holding a bytes column.'
			}
		]
	})
