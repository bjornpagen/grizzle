/**
 * A served login's records (packages/grizzle adapter/public/records.ts recordedOf), read off its served file alone, as
 * a den worker reads them with no records value, query or schema at hand: the file generate compiles for a login
 * whose programs read a records' relations carries the records (served/forms.ts ServedFile records), its query's rows'
 * decoder form exactly, through the file's text and back; recordedOf's text of a found row is the compile's rowText of
 * the query, byte for byte, and its facts of found rows the compile's recordsFacts, the same insert; and a records the
 * login's programs read nothing of is carried by no file, recordedOf of it RecordsUnserved. Drawn over every shape of
 * a records' query over Shelves (test/support/agreement/records.ts): each delivery, an option, one child, an arm and an
 * array, at depths one to three, attachment names that repeat, and an owner of one field or two.
 *
 * Oracle: the compile's own readings of the records' value (rowText, recordsFacts), which share the one text and the
 * one insert (runtime/read/text.ts rowTextOf, runtime/records.ts recordsFacts) over its form and its layout.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { RecordsUnserved } from "#adapter/errors/failures.ts"
import type { RecordsShape } from "#test/support/agreement/records.ts"
import { recordsCase, recordsShapeGen } from "#test/unit/served/records.fixtures.ts"

/** What a case's records hold below its books: each delivery, a nested array, a third level, a two-field owner. */
type ServedRecordsFeature =
	| "an option"
	| "one child"
	| "an arm"
	| "a nested array"
	| "a third level"
	| "an owner of two fields"

/** The features a shape reaches. */
const reached = (shape: RecordsShape): ReadonlyArray<ServedRecordsFeature> => {
	const b = shape.books
	const delivered = (a: Option.Option<{ readonly delivery: string }>, delivery: string): boolean =>
		Option.exists(a, (x) => x.delivery === delivery)
	const ink = Option.flatMap(b.spine, (spine) => spine.ink)
	const remark = Option.flatMap(b.chapters, (ch) => ch.remark)
	const holds = (yes: boolean, f: ServedRecordsFeature): ReadonlyArray<ServedRecordsFeature> =>
		yes ? [f] : []
	return [
		...holds(
			delivered(b.blurb, "option") ||
				delivered(b.spine, "option") ||
				delivered(b.paper, "option") ||
				delivered(b.digital, "option") ||
				delivered(ink, "option") ||
				delivered(remark, "option"),
			"an option"
		),
		...holds(delivered(b.spine, "one"), "one child"),
		...holds(delivered(b.paper, "arm") || delivered(b.digital, "arm"), "an arm"),
		...holds(Option.isSome(b.chapters), "a nested array"),
		...holds(Option.isSome(remark) || Option.isSome(ink), "a third level"),
		...holds(shape.owner === "runStep", "an owner of two fields")
	]
}

/**
 * A served file carries the records its login's programs read, and recordedOf reads a found row's text and the insert
 * of found rows off it as the compile reads them off the records' value; no file carries a records no program reads.
 */
export const aServedLoginsRecordsReadEveryRowAsTheirQueryAndValueDo = property.explore(
	recordsShapeGen,
	{
		needs: {},
		situations: [
			"an option",
			"one child",
			"an arm",
			"a nested array",
			"a third level",
			"an owner of two fields"
		] satisfies ReadonlyArray<Reached<ServedRecordsFeature>>,
		budget: { runs: 24, steered: 24 },
		check: (_, notes: Case<ServedRecordsFeature>) => (shape) =>
			Effect.sync(() => {
				for (const feature of reached(shape)) {
					notes.note(feature)
				}
				const c = recordsCase(shape)
				assert.deepEqual(
					c.carried,
					["Kept"],
					"the file carries the records its programs read, and those alone"
				)
				assert.deepEqual(
					c.form.served,
					c.form.query,
					"the records' form, through the file's text and back"
				)
				assert.deepEqual(c.text.served, c.text.query, "a found row's text")
				assert.deepEqual(c.facts.served, c.facts.query, "the insert of found rows")
				assert.throws(c.aside, RecordsUnserved)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the compile's rowText and recordsFacts of the records' own query and value"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/records.ts",
				original: "if (recorded !== undefined && footprint.has(recorded.root.relation.name)) {",
				replacement: "if (recorded !== undefined) {",
				why: "A served file carries every records its base lists, those its programs read nothing of among them: Aside is carried."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: "[...names].toSorted(compareStrings).map((name) => {",
				replacement: "[...names].toSorted(compareStrings).slice(0, 0).map((name) => {",
				why: "A served records carries none of the rosters its code columns name: a book's kind, read against its roster, finds none."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: "\t\tholding: a.holding.kind,",
				replacement: '\t\tholding: a.holding.kind === "one" ? "option" : a.holding.kind,',
				why: "A one child's records are laid out as an option's: the served insert reads its child as an Option and refuses the row."
			}
		]
	}
)
