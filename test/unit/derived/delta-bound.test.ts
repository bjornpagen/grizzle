/**
 * A derived relation whose unit bounds no upkeep, its unit the learner and its relations keyed apart past it, is stored
 * where its delta form bounds its upkeep (analysis/derived/storage.ts boundOf, analysis/theory/upkeep.ts deltaBoundOf):
 * checked, its arms joining and negating relations alone, every rule reached from its head by keys, or by seeks, each an
 * existence test of one occurrence at the fields the head binds, one descent of an index of them and at most one range
 * of one more column, whose changed rows name their one fact each by keys (analysis/theory/unit.ts StepBy `seek`), so a
 * write reads each fact it gains from the rows it wrote outward and checks each fact it may withdraw at the fact, or at
 * the stored table's rows at more than the unit's fields, by probes and ranges of keys, whatever the width of its unit;
 * or monotone, its arms negating nothing and holding closed relations alone, so a served write only gains facts and a
 * data step's bracket makes the table its definition's rows again (physical/ddl/recheck.ts). It is live for its upkeep
 * otherwise, with why its delta form bounds none. A form over closed relations alone that negates none loses no fact to
 * a served write, a closed relation's removed rows read by none (analysis/theory/upkeep.ts sidesOf): its loss is closed
 * (ClosedLoss).
 *
 * The box is every definition of delta-bound.fixtures.ts, each ledger's own in the box's terms, its imports read by name
 * where their canonical relations are stored: TestSnapshot; SessionSnapshot over the stored TestSnapshot and over its
 * query imported; ItemSessionControl over a sealed package's controls read by reference; ItemSessionOpen, SettledSitting,
 * UnsettledSitting and UnsettledFinal; each sitting with a suspended candidate session, a join of an open visit and the
 * suspension; each candidate session of a sitting with an item session, over the closed visits and over the open ones;
 * each sitting with a late open visit, a range of two columns; each snapshot of an enrolled learner, of a member, and of
 * no member snapshot.
 *
 * The oracle is the rule restated as a model (delta-bound.fixtures.ts holdingOf): TestSnapshot, SessionSnapshot in both
 * forms, ItemSessionControl, ItemSessionOpen, SettledSitting, UnsettledSitting and the enrolled snapshots stored by
 * their checked delta forms, ItemSessionOpen's tried sessions and UnsettledSitting's attempts read by seeks, and
 * UnsettledFinal at the sitting by its stored import's key; the visited item sessions, by a seek whose rows name their
 * facts by no key, monotone over closed relations; TestSnapshot's, ItemSessionControl's, the enrolled snapshots' and the
 * visited item sessions' loss closed, the others' checked; the suspended sittings and the late visits, reached by
 * probes of the open visits, stored at the sitting by a monotone form, its loss a unit form; the open visits' item
 * sessions and the member snapshots live for their open relation, and the snapshots of no member snapshot for the live
 * query they negate.
 *
 * Features: each shape's holding.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { compiledOf } from "#test/unit/analysis/theory/rule-query.fixtures.ts"
import {
	deltaSchemaOf,
	holdingOf,
	holdingStated,
	type Shape,
	shapeGen
} from "#test/unit/derived/delta-bound.fixtures.ts"

/** A derived relation whose unit bounds no upkeep is stored exactly where its delta form is checked or monotone over
 * closed relations. */
export const aRelationWhoseUnitBoundsNoUpkeepIsStoredExactlyWhereItsDeltaFormIsCheckedOrMonotoneOverClosedRelations =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"snapshots",
			"session snapshots",
			"imported session snapshots",
			"controls",
			"open sessions",
			"settled sittings",
			"unsettled sittings",
			"unsettled finals",
			"suspended sittings",
			"visited item sessions",
			"open visits' item sessions",
			"late visits",
			"non-member snapshots",
			"enrolled snapshots",
			"member snapshots"
		] satisfies ReadonlyArray<Reached<Shape>>,
		check: (_, c: Case<Shape>) => (shape) =>
			Effect.sync(() => {
				const artifacts = succeeded(
					compiledOf(deltaSchemaOf(shape)),
					"every schema of the box compiles"
				)
				const expected = holdingOf(shape)
				assert.deepEqual(holdingStated(artifacts), expected, Formatter.format(shape))
				c.note(shape)
			}),
		oracle: {
			kind: "specification",
			name: "the rule restated (delta-bound.fixtures.ts holdingOf): stored by its checked delta form where its arms join and negate relations alone, every rule is reached from its head by keys or by seeks whose rows name their facts by keys and every lost fact is read at the fact or at more than the unit; stored as monotone where its arms negate nothing and hold closed relations alone; live for its upkeep otherwise with the first condition its delta form lacks"
		},
		box: "ledger's TestSnapshot, SessionSnapshot in both forms, ItemSessionControl, ItemSessionOpen, SettledSitting, UnsettledSitting and UnsettledFinal in the box's terms, three existence tests that read rows or name their facts by no key, and a learner's snapshots under a closed enrolment, an open membership and no member snapshot, each at the learner's unit",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: '\t\tcase "checked":\n\t\tcase "monotone":\n\t\t\treturn { kind: "delta" }\n',
				replacement:
					'\t\tcase "checked":\n\t\t\treturn { kind: "unbounded", why: { kind: "copy", relation: "" } }\n\t\tcase "monotone":\n\t\t\treturn { kind: "delta" }\n',
				why: "A checked delta form read as no bound: ledger's TestSnapshot, SessionSnapshot and ItemSessionControl live, every reader re-deriving a learner's snapshots and controls (qti-pie's P8 case)."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: '\t\tcase "checked":\n\t\tcase "monotone":\n\t\t\treturn { kind: "delta" }\n',
				replacement:
					'\t\tcase "monotone":\n\t\t\treturn { kind: "unbounded", why: { kind: "copy", relation: "" } }\n\t\tcase "checked":\n\t\t\treturn { kind: "delta" }\n',
				why: "A monotone form over closed relations read as no bound: the enrolled snapshots live, every reader re-deriving a learner's snapshots, though a served write only gains them."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original:
					'\t\t\tif (c.arms.some((arm) => arm.negated.length > 0)) {\n\t\t\t\treturn { kind: "unbounded", why: c.why }\n',
				replacement: '\t\t\tif (false) {\n\t\t\t\treturn { kind: "unbounded", why: c.why }\n',
				why: "A negating form read as monotone: one over closed relations stored with no lost form, though an insert of a negated row withdraws its facts, which a monotone upkeep never removes; the non-member snapshots named live for the open membership they hold, not for the query they negate."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original:
					'\tconst negatedQuery = arms.some((arm) => arm.negated.some((n) => n.source.kind !== "relation"))\n',
				replacement: "\tconst negatedQuery = false\n",
				why: "A negation of a query read as a probe of one relation: the snapshots of no member snapshot, the live query negated, taken for a checked form, though no probe of a key checks a fact the negated query's rows withdraw."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: '\t\t\t\treturn held?.kind !== "relation" || held.mutable\n',
				replacement: "\t\t\t\treturn false\n",
				why: "A monotone form over an open relation stored: a served delete of a membership withdraws the learner's every snapshot, which its upkeep re-derives at the whole learner."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\tif (stored.kind === "none") {\n\t\treturn undefined\n\t}\n',
				replacement:
					'\tif (stored.kind === "none" || stored.kind === "table") {\n\t\treturn undefined\n\t}\n',
				why: "No lost candidate read from the stored table: ledger's SessionSnapshot live, a removed snapshot withdrawing its facts in sessions it binds no field of, its readers re-deriving the learner's snapshots."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\tif (bound.length <= stored.unit.length || !stored.unit.every((f) => bound.includes(f))) {\n",
				replacement: "\tif (false) {\n",
				why: "A lost candidate read from the stored table at the learner alone: a removed enrolment reads every stored snapshot of the learner, the whole unit, as a checked form, where the unit's width bounds the read."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\t\t? "seek"\n',
				replacement: '\t\t\t\t? "probe"\n',
				why: "No existence test of one occurrence reached: ledger's UnsettledSitting and ItemSessionOpen live, each read at a sitting or a session by a prefix of its stored import's key, every reader re-deriving the learner's attempts."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\tif (others.some((o) => Object.values(o.read.bound).some((v) => free.has(v)))) {\n\t\treturn false\n\t}\n",
				replacement: "",
				why: "A projection that returns rows read as existence: the suspended sittings' visits and suspensions joined at the session taken for one descent of an index, though the check at a sitting reads every visit of it."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\treturn ranged.size <= 1\n",
				replacement: "\treturn true\n",
				why: "A range of two columns read as one index range: the late visits' check at a sitting taken for one descent, though it reads every visit numbered above 1 for one that began after instant 100."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\t\t\t\t\tconst moved = movedByKey(step.read, closure.keyed, head, close)\n",
				replacement: "\t\t\t\t\tconst moved = undefined\n",
				why: "A seek's changed rows taken to name one fact by a key: an item session inserted in a sitting moves every candidate session's fact of it, which its upkeep reads as if one."
			}
		]
	})
