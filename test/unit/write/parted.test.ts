/**
 * A single statement sends the parts a call's inputs may give rows, and only those (runtime/write/parted.ts): each part
 * whose rows need an input holding no fact is left out, its text, its placeholders and so its trigger with it, every
 * other unit is sent, and the units sent assemble, placeholders numbered again, into the text the printer prints of
 * them. A call whose inputs give every part rows sends the whole statement byte for byte.
 *
 * The box: H, one fact a call, from a scalar parameter; three sidecars S1, S2, S3, each from its own relation parameter
 * p1, p2, p3; G, from a union of one rule over p1 and one over p2; each parameter holding none, one or two facts; and a
 * read-back of S1's added facts riding the statement or none. The five writes are one single statement
 * (write/schedule/plan.ts realizationOf).
 *
 * The oracle is the rule, a specification over the box: H is sent in every call, each S_i where p_i holds a fact, G
 * where p1 or p2 does, and S1 wherever a read-back rides, whose delta reads it; and the whole statement's text is the
 * printer's (artifact spec.sql) byte for byte, under its name.
 *
 * Features: a part left out, every part sent, no sidecar sent, G sent for one of its two parameters, a rider keeping
 * S1 whose parameter is empty.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { prepared } from "#compiler/core/prepared.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { wholeForm } from "#test/support/whole-forms.ts"
import {
	boxGen,
	changesOf,
	G,
	H,
	insertedInto,
	placeholdersOf,
	programOf,
	S1,
	S2,
	S3,
	sentOf,
	tableOf
} from "#test/unit/write/parted.fixtures.ts"

type Situation =
	| "a part left out"
	| "every part sent"
	| "no sidecar sent"
	| "G sent for one of its two parameters"
	| "a rider keeping S1 whose parameter is empty"

/** A single statement sends exactly the parts its call's inputs may give rows, assembled as the printer prints them,
 * and its whole text where they give every part rows. */
export const aSingleStatementSendsExactlyThePartsItsCallsInputsMayGiveRowsAssembledAsThePrinterPrintsThem =
	property.exhaust(finite(boxGen), {
		box: "H, three sidecars from p1, p2 and p3, G from a union over p1 and p2, each parameter none to two facts, a rider of S1's added facts or none",
		needs: {},
		situations: [
			"a part left out",
			"every part sent",
			"no sidecar sent",
			"G sent for one of its two parameters",
			"a rider keeping S1 whose parameter is empty"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (box) =>
			Effect.gen(function* () {
				const changes = changesOf(box.rider)
				const program = programOf(changes)
				const flight = flightOf(servableWrite(program), program.frontend.codes)
				const parted = Arr.filter(flight.statements, (s) => s.kind === "parted")
				assert.equal(parted.length, 1, "the five writes are one single statement")
				const single = defined(parted[0], "the single statement")
				const printed = defined(
					program.artifact.statements[single.index],
					"the single statement as the artifact holds it"
				)
				const whole = wholeForm(single)
				assert.equal(
					whole.text.sql,
					printed.spec.sql,
					"every unit assembles into the printed text byte for byte"
				)
				assert.equal(
					whole.text.name,
					prepared(printed.spec.sql).name,
					"under the printed text's name"
				)
				const sent = yield* sentOf(program, flight, changes, box)
				const call = defined(
					sent[single.index],
					"the call sends the single statement, H's fact among it"
				)
				const holds = { p1: box.facts.p1 > 0, p2: box.facts.p2 > 0, p3: box.facts.p3 > 0 }
				const expected = Arr.map(
					[
						H,
						...(holds.p1 || box.rider ? [S1] : []),
						...(holds.p2 ? [S2] : []),
						...(holds.p3 ? [S3] : []),
						...(holds.p1 || holds.p2 ? [G] : [])
					],
					tableOf
				)
				assert.deepEqual(
					Arr.sort(insertedInto(call.form.text.sql), Order.String),
					Arr.sort(expected, Order.String),
					"the call inserts into exactly the relations its inputs may give rows"
				)
				assert.deepEqual(
					placeholdersOf(call.form.text.sql),
					Arr.map(call.form.paramSlots, (_slot, i) => i + 1),
					"its placeholders are $1 to its slots' count, each once"
				)
				assert.equal(call.values, call.form.paramSlots.length, "a value for each placeholder sent")
				const all = holds.p1 && holds.p2 && holds.p3
				if (all) {
					assert.equal(
						call.form.text.sql,
						printed.spec.sql,
						"a call whose inputs give every part rows sends the whole text"
					)
				}
				c.note(all ? "every part sent" : "a part left out")
				if (!holds.p1 && !holds.p2 && !holds.p3) {
					c.note("no sidecar sent")
				}
				if (holds.p1 !== holds.p2) {
					c.note("G sent for one of its two parameters")
				}
				if (box.rider && !holds.p1) {
					c.note("a rider keeping S1 whose parameter is empty")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a part is sent exactly where its member's inputs may give it rows, or a riding read-back reads it, and the units assemble into the printer's text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/parted.ts",
				original: '\t\tif (unit.kind === "part" && !holds(unit.needs, holdsFact)) {',
				replacement:
					'\t\tif (unit.kind === "part" && (!holds(unit.needs, holdsFact) || unit.needs.flat().length === 1)) {',
				why: "A call leaves out every part whose rows need one input, though its input holds facts: a shape that drops a non-empty member."
			},
			{
				file: "packages/engine/src/logical/needs.ts",
				original: '\t\t\t\t\t\treturn needing({ kind: "declared", param: n.input.param })',
				replacement: "\t\t\t\t\t\treturn always",
				why: "A relation parameter is taken to hold facts whatever it holds, so every empty member is sent, as before."
			},
			{
				file: "packages/engine/src/logical/needs.ts",
				original: "\t\t\t\treturn either(unionArms(n.groups).map(of))",
				replacement: "\t\t\t\treturn both(unionArms(n.groups).map(of))",
				why: "A union's rows taken to need every arm's input, so G is left out where only one of p1 and p2 holds facts."
			},
			{
				file: "packages/engine/src/write/program/single.ts",
				original: "\t\tneeds: read.has(at) ? always : o.needs,",
				replacement: "\t\tneeds: o.needs,",
				why: "A part a riding read-back's delta reads is left out where its input holds no fact, its delta then over a CTE no statement holds."
			},
			{
				file: "packages/engine/src/runtime/write/parted.ts",
				original: `\t\ttext += \`$\${before + hole + 1}\${after}\``,
				replacement: `\t\ttext += \`$\${hole + 1}\${after}\``,
				why: "Each unit's placeholders numbered from $1 in every call, so a later unit's text names an earlier unit's values."
			},
			{
				file: "packages/engine/src/runtime/write/parted.ts",
				original: `\tconst head = ctes.length === 0 ? "" : \`WITH \${ctes.join(",\\n")}\\n\``,
				replacement: `\tconst head = ctes.length === 0 ? "" : \`WITH \${ctes.join(", ")}\\n\``,
				why: "The units joined otherwise than the printer joins a WITH's CTEs, so the whole statement's text and name change."
			}
		]
	})
