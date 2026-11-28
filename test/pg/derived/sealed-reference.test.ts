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
 * learners' attempts at the item, committed, and measures again; each statement under its routine's advice
 * (test/support/advice.ts routineAdviceHeld). The oracle: each statement does the same work both times (judge.ts
 * scannedWork), rows counted over every loop, never a clock.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property, ReplayToken } from "@bjornpagen/testing/property"
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
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/sealed-reference.test.ts#aStoredRelationThatReadsSealedContentByReferenceEqualsItsDefinitionAfterEveryCommit:1f.2:2.0.1.0.0.0.0.2.0"
				),
				reason:
					"Learner 1's answer at package 1's adaptive item 0, its founding in the same transaction, then a data step's revision of the item, no longer adaptive: the bracket's re-check refills Open, whose definition now derives the attempt, by a MERGE the binding read its table through at the tuple id a probe found, `USING <its definition> CROSS JOIN LATERAL (<Open at the key> LIMIT 1) ON ctid`, an inner join that dropped every row of the definition Open did not yet hold before its WHEN NOT MATCHED could insert it, so Open lacked (1,1,0,1) while Credit's, Scored's, Tried's and Noted's raised maximums, rows they held, were updated (main f9cb21bb, since the binding's cutover 2d024bca)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					'\t\tconst depth = inner.depth + 1\n\t\tconst level: Env = { ...inner, depth }\n\t\tconst [entry, ...others] = entriesOf([s.using])\n\t\tif (entry === undefined || others.length > 0) {\n\t\t\treturn defect("a MERGE\'s one source, one item")\n\t\t}\n\t\tconst sourceWritten = writtenOf(entry.source)\n\t\tconst sourceAlias = this.#alias(sourceWritten)\n\t\tconst source = this.entry(entry, 1, [], level, inner, sourceAlias, undefined)\n\t\tconst alias = this.#alias(s.alias)\n\t\tconst withTarget = withRelation(level, s.alias, alias, depth, 0)\n\t\tconst here =\n\t\t\tsourceWritten === undefined\n\t\t\t\t? withTarget\n\t\t\t\t: withRelation(withTarget, sourceWritten, sourceAlias, depth, 1)\n\t\tthis.#level(name, [\n\t\t\t{\n\t\t\t\tsource: { kind: "read", table: s.table, alias, access: { kind: "whole" } },\n\t\t\t\tstep: { join: "cross" },\n\t\t\t\titem: {\n\t\t\t\t\talias,\n\t\t\t\t\tscan: catalogTable === undefined ? { kind: "rows" } : { kind: "seq" }\n\t\t\t\t},\n\t\t\t\tmethod: "nestedLoop",\n\t\t\t\tappended: []\n\t\t\t},\n\t\t\t{ ...source, method: "hash" }\n\t\t])\n\t\tconst [using] = fromOf([source])\n\t\tif (using === undefined) {\n\t\t\treturn defect("a MERGE\'s one source, bound as one item")\n\t\t}\n\t\tconst rename = this.renamer(here)\n\t\treturn {\n\t\t\t...s,\n\t\t\twith: w,\n\t\t\talias,\n\t\t\tusing,\n\t\t\ton: rename.expr(s.on),\n',
				replacement:
					'\t\tconst t = this.written(s.table, s.alias, [s.using], s.on, inner, name)\n\t\tconst [using] = t.items\n\t\tif (using === undefined || t.items.length !== 1) {\n\t\t\treturn defect("a MERGE\'s one source, bound as one item")\n\t\t}\n\t\tconst rename = this.renamer(t.env)\n\t\treturn {\n\t\t\t...s,\n\t\t\twith: w,\n\t\t\talias: t.alias,\n\t\t\tusing,\n\t\t\ton: t.where ?? lit.bool(true),\n',
				why: "A MERGE's target read at the tuple id an inner probe of it at its ON's key finds, as an UPDATE's or a DELETE's target is: a data step's revision of an item no longer adaptive re-checks Open by a MERGE whose definition's rows Open does not hold never reach its WHEN NOT MATCHED, so the attempt's fact stays underived (the binding's cutover, 2d024bca)."
			},
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

/** A learner's answer's judge work at COMMIT does the same work however many packages, attempts of the learner and other learners' attempts stand, at every table size. */
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
			name: "a bound and invariance: each statement the judge runs at an answer's COMMIT does the same work beside a few packages and attempts and beside many, at tables of a page and of many"
		},
		box: "one or four attempts of learner 1 at the item before the first measure, beside no other package and learner or 2,048 of each; sixteen or sixty-four packages, attempts of learner 1 at another package and other learners' attempts at the item added",
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/sealed-reference.test.ts#aLearnersAnswerKeepsStoredRelationsOverSealedContentByItsOwnRowsAndTheContentItNames:-:0.0.0"
				),
				reason:
					"No background, one attempt, sixteen more: Tried's unit form deletes each stale row of its table by `DELETE … WHERE ctid = __stale`, which the binding read whole, advised SEQ_SCAN, its table read for each stale row, 1 row and then 18, where one heap fetch finds it (main 2dc71d9e, since the binding's cutover 2d024bca)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original:
					'\t\t\t\t: where.map((c) => bindingOf(c, written)).find((b) => b?.op === "=" && b.column === tupleId)\n',
				replacement: "\t\t\t\t: undefined\n",
				why: "A write's target its condition states at a tuple id read whole: Tried's unit form deletes each stale row by a Seq Scan of its table, every learner's group read for each, where a TID scan fetches the one row."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\trestriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,\n',
				replacement: "\t\t\twalkedText,\n",
				why: "A unit form's definition read whole, not per written unit: each answer re-derives every learner's attempt counts, the work the result page and the player paid for reading them live (16.8M pages, a 1.4M-attempt rescan)."
			}
		]
	})
