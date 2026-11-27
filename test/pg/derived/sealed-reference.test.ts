/**
 * A derived relation unit-local in a learner's unit that otherwise reads only a sealed package's content is stored in the
 * learner's unit, the content read by reference (analysis/theory/unit.ts storedUnit): on PostgreSQL 19, over
 * SealedReference (sealed-reference.fixtures.ts), a package's items and hints in a unit sealed at founding, each
 * learner's attempts and their variables in the learner's unit, every attempt naming an item of a founded package; a
 * stored relation of the content alone, kept at the package's founding (ledger's MaximumOutcome); and five stored
 * relations over both, each attempt with its item's maximum (ledger's AttemptCredit), each attempt at an item not
 * adaptive (ItemSessionOpen), each attempt not ended through a hint that counts none, the hints a query of the content
 * alone (CountedAttempt), each attempt with its item's maximum through the content's stored relation, a stratum above
 * its upkeep, and each learner's attempts at an item counted beside its maximum (numAttempts), a fold, whose upkeep is
 * a unit form, where each of the others' is a delta form, every import of theirs a stored relation read by its name;
 * and each learner's notes with their items' maximum (Noted), a learner's note mutable in the learner's unit, so its
 * one holder is open and the closed content is a relation it reads by reference alone (ir/unit.ts StoredUnit
 * `references`).
 *
 * Exactness: a drawn sequence of transactions as the owner's direct SQL, each a package's founding, an answer at a
 * founded package's item or at one its own transaction founds, or a data step that changes an item's adaptivity and
 * maximum and removes its hint, as a migration revises content; after each COMMIT every stored relation's table holds
 * exactly its definition's rows over the host's model. A founding changes no stored row but at the learners its own
 * transaction writes: every learner's row names a package founded before it stood. A data step's removal or update of
 * content, the one write that changes content a learner's row names, is followed by its bracket's re-check
 * (test/support/data-step.ts asDataStep, physical/ddl/recheck.ts), which makes each stored relation over it its
 * definition's rows again, level by level, the content's stored relation before the relations over it, Noted among
 * them, which reads the content by reference alone, its holder open; and phase A
 * keeps each stored relation a stratum above the stored relations it reads by reference, so an answer at content its
 * own transaction founds reads the content's stored relation as its upkeep left it. The oracle is the model: each
 * definition read over the host's rows.
 *
 * The bound: a learner's answer's judge work at COMMIT reads the attempt it wrote and the content at its package and
 * item by their keys, however many packages, attempts of the learner and other learners stand, at every table size.
 * Each case founds packages and other learners' attempts, none or 2,048 of each, so the tables are a page or a dozen
 * and more, and learner 1's few attempts at an item, committed, and measures the judge's work at a fresh answer's
 * COMMIT, every statement explained with ANALYZE and BUFFERS before the judge runs, in a transaction rolled back
 * (test/support/judge.ts judgeRun); then founds more packages, adds attempts of learner 1 at another package and other
 * learners' attempts at the item, committed, and measures again; with no planner setting and no ANALYZE. The oracle:
 * no statement reads a table larger than one index probe whole (judge.ts wideScans), and each does the same keyed work
 * both times (judge.ts keyedWork), rows counted over every loop, never a clock; a table of a page PostgreSQL reads whole
 * for what a probe of it costs.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type BoundFeature,
	boundGen,
	type ExactFeature,
	exactCase,
	runBound,
	runExact,
	sealedReferenceTemplate
} from "#test/pg/derived/sealed-reference.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A stored relation over a sealed unit's content equals its definition after every COMMIT, a founding's, an answer's
 * and a data step's revision of the content alike. */
export const aStoredRelationThatReadsSealedContentByReferenceEqualsItsDefinitionAfterEveryCommit =
	property.explore(exactCase, {
		needs: { installed: Substrate.fresh(sealedReferenceTemplate) },
		situations: [
			"published a package",
			"answered a founded package's item",
			"answered an item in its package's founding",
			"revised content in a data step",
			"revised content an attempt names"
		] satisfies ReadonlyArray<Reached<ExactFeature>>,
		check:
			({ installed }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* installed
					const session = yield* substrate.session({ ...ownerSession(), label: "sealed exact" })
					yield* runExact(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "second-implementation",
			name: "the host's model: after each COMMIT each stored relation holds exactly its definition's rows over the rows the host wrote, its content's revisions among them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/recheck.ts",
				original: "\t\tif (!overClosed(u)) {\n",
				replacement: "\t\tif (true) {\n",
				why: "No refill: a data step's revision of an item an attempt names leaves its stored credit, openness and count as they were before it, no re-check making them their definitions' rows again."
			},
			{
				file: "packages/engine/src/physical/ddl/recheck.ts",
				original:
					"\t\tu.stored.references.length > 0 || readsClosed(u.reads.map((r) => r.relation))\n",
				replacement: "\t\treadsClosed(u.reads.map((r) => r.relation))\n",
				why: "A stored relation is refilled only where a holder is closed, never where it reads closed content by reference alone: Noted, its one holder the open Note, keeps the maximum a data step's revision raised past, no re-check making it its definition's rows again."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\tconst below = [...u.reads.map((r) => r.relation), ...u.stored.references].flatMap(\n",
				replacement: "\t\tconst below = u.reads.map((r) => r.relation).flatMap(\n",
				why: "A stored relation kept in the stratum of the stored relation it reads by reference: its upkeep runs beside that relation's, reading the content's stored relation before this COMMIT's upkeep of it has written it, so an attempt's credit through the content's maximum misses the maximum its own transaction founds."
			}
		]
	})

/** A learner's answer's judge work at COMMIT reads no table larger than a probe whole and does the same keyed work
 * however many packages, attempts of the learner and other learners' attempts stand, at every table size. */
export const aLearnersAnswerKeepsStoredRelationsOverSealedContentByItsOwnRowsAndTheContentItNames =
	property.exhaust(finite(boundGen), {
		needs: { installed: Substrate.fresh(sealedReferenceTemplate) },
		situations: [
			"Credit's upkeep ran",
			"Open's upkeep ran",
			"Counted's upkeep ran",
			"Tried's upkeep ran",
			"tables of a page",
			"tables of many pages"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			({ installed }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* installed
					const session = yield* substrate.session({ ...ownerSession(), label: "sealed bound" })
					yield* runBound(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "universal",
			name: "a bound and invariance: each statement the judge runs at an answer's COMMIT reads no table larger than a probe whole, and does the same keyed work beside a few packages and attempts and beside many, at tables of a page and of many"
		},
		box: "one or four attempts of learner 1 at the item before the first measure, beside no other package and learner or 2,048 of each; sixteen or sixty-four packages, attempts of learner 1 at another package and other learners' attempts at the item added",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\trestriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,\n',
				replacement: "\t\t\twalkedText,\n",
				why: "A unit form's definition read whole, not per written unit: each answer re-derives every learner's attempt counts, the work the result page and the player paid for reading them live (16.8M pages, a 1.4M-attempt rescan)."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\tconst seek = fencedRead(\n",
				replacement: "\t\t\tconst seek = ((t, i, w) => simpleSelect(t, [i], w))(\n",
				why: "A unit form's DELETE that joins its table to the region as PostgreSQL estimates, not by a lookup of its own: a learner's one answer hashed a scan of the whole stored count, 2,049 rows, beside 2,048 learners (Tried's, Counted's before its import was read by name)."
			}
		]
	})
