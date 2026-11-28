/**
 * A stored derived relation kept by its delta program equals its definition after every COMMIT (analysis/theory/
 * upkeep.ts; physical/ddl/rules.ts upkeepBlock): each rule of its definition read from the rows a transaction wrote
 * outward, along the keys they bind, a computed key among them, its facts inserted by its table's primary key; and the
 * facts a write withdraws, a negated row's insert or a read row's removal, each candidate read at its table's key and
 * checked at the fact against the definition as it stands at COMMIT (a checked form), or the units the removed rows
 * touch re-derived (a monotone form): so no fact the definition derives is missed or kept past its last derivation.
 *
 * The box: a learner's sittings, four relations in the learner's unit (a sitting's candidate sessions, the suspensions
 * that ended them, its presentations and its end), closed, or open in half the cases, written by a writer that updates
 * and deletes them; Pairs, a stored relation of pairs of a sitting's instants, SittingOrder's heading, of one to four
 * drawn rules, each two occurrences joined at their candidate session, at the next one (k + 1, a computed key), at the
 * sitting alone (a product), at the sitting with the second later (a product cut by an order), one occurrence alone, or
 * one occurrence where the other holds no row at its session (a negation); Standing beside it, AssignmentStatus's shape,
 * of one to three drawn rules, each one holder's row tagged by its rule, read at its key from the fact, where up to two
 * holders hold no row at its session or its sitting; and, in two cases of three, Later, each pair whose later
 * instant begins a visit, reading Pairs' table, Pairs named a level below or the query Later imports, which its upkeep
 * reads by its canonical relation's name, after Pairs' own, never Pairs' definition spelled in place. A drawn sequence of transactions of the owner's direct SQL writes rows
 * at one learner's two sittings, three sessions and four instants, so rows meet, each committed before the next; one in
 * four is a migration's data step, in the bracket a custom migration's step runs in, which also deletes and updates rows
 * of the closed holders, the one writer that can (physical/ddl/immutable.ts). Cases aim at each way a fact is lost or
 * given back: a fact two rules derive losing one derivation, a negated row's insert, a negated row's removal, an open
 * holder's update, and a fact of Pairs kept by its monotone form that a removal withdraws.
 *
 * The oracle is PostgreSQL's: after each COMMIT, in one read-only snapshot, each derived relation's rows and its
 * definition's, the definition evaluated by the conservative lowering, which relies on no evidence (oracle/harness.ts).
 *
 * Features: each join of a stored rule, a stored relation read a level above, named or imported, two sittings in one
 * transaction, each
 * write of an open holder, each way a fact is lost or given back, and each stored relation kept by its form.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DeltaFeature,
	deltaCaseGen,
	deltaRun
} from "#test/pg/derived/delta-upkeep.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** A stored relation kept by its delta program holds its definition's rows after every COMMIT, whatever its holders' writes. */
export const aStoredRelationKeptByItsDeltaProgramEqualsItsDefinitionAfterEveryCommit =
	property.explore(deltaCaseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"rule key stored",
			"rule next stored",
			"rule sitting stored",
			"rule later stored",
			"rule single stored",
			"rule unless stored",
			"a stored relation read above",
			"a stored relation imported unnamed read above",
			"two sittings in one transaction",
			"a data step deleted a holder's row",
			"a data step inserted a row and deleted it again",
			"a writer deleted an open holder's row",
			"a writer updated an open holder's row",
			"a fact two rules derive lost one derivation",
			"a fact withdrawn by a negated row's insert",
			"a fact gained by a negated row's removal",
			"a Pairs fact withdrawn by a negated row's insert",
			"a Pairs fact its monotone form loses",
			"Pairs kept by its monotone form",
			"Pairs kept by its checked form",
			"Later kept by its checked form",
			"Standing kept by its checked form"
		] satisfies ReadonlyArray<Reached<DeltaFeature>>,
		check:
			({ substrate }, c) =>
			(value) =>
				Effect.provideServiceEffect(
					Effect.scoped(deltaRun(value, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "each derived relation's rows against its definition evaluated by the conservative lowering, in one snapshot after each COMMIT"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/derived/delta-upkeep.test.ts#aStoredRelationKeptByItsDeltaProgramEqualsItsDefinitionAfterEveryCommit:-:1.0.0.0.0.1.3.1.0.0.0.0.0.2.1.1.3.0.0.0.0.1.3.0.1"
				),
				reason:
					"a closed end's instant changed by a data step, Standing's fact of it at one key of Standing's withdrawn and given again at another instant: its gain, run before its removal in a part of its own, met the withdrawn fact at the key and inserted nothing, and the removal then deleted that fact, Standing left empty (LOCKS-P3's first split of the upkeep's calls into parts apart)",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\tconst rules = heldBy(arms, u.holder).flatMap((r) =>",
				replacement: "\tconst rules = heldBy(arms, u.holder).slice(0, 1).flatMap((r) =>",
				why: "A delta program reads the rows its first holder gains alone: a suspension inserted under a standing visit gains Pairs no fact of their join, which its table never holds."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\t\t\treturn c.arms.every((arm) => arm.negated.length === 0)",
				replacement: "\t\t\treturn c.arms.every(() => true)",
				why: "A definition that negates and whose head reaches no match by its key is kept by the monotone form, which re-derives only what a removal touches: a suspension inserted at a visit's session withdraws Pairs' unless fact of the visit (the situation's aim), which its table keeps."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\t\t\t\t\treturn [partCall("lost", unitBody(loss))]',
				replacement:
					'\t\t\t\t\t\treturn [partCall("lost", ((a) => ({ by: a.by, body: a.body.slice(1) }))(unitBody(loss)))]',
				why: "A monotone form deletes nothing at the units the rows a write removes touch, only inserting what they derive: a data step's delete of a visit leaves its pairs in Pairs' table."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\t\t\t\t\treturn [partCall("lost", checkedBody(loss))]',
				replacement:
					'\t\t\t\t\t\treturn [partCall("lost", ((a) => ({ by: a.by, body: a.body.map((s): PlStatement => ({ kind: "if", branches: [{ condition: lit.bool(false), body: [s] }], else: [] })) }))(checkedBody(loss)))]',
				why: "A checked form deletes nothing, its DELETE never run: an end inserted under a standing visit withdraws Standing's fact of the visit, which its table keeps."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\t\treturn appendNonEmpty(\n\t\t\t\tlost,\n\t\t\t\tpartCall("gained", {\n\t\t\t\t\tby: deltaRequester,\n\t\t\t\t\tbody: { declare: [], body: [inserting(gained.statement, headingOf(gained))] }\n\t\t\t\t})\n\t\t\t)\n',
				replacement:
					'\t\t\treturn [\n\t\t\t\tpartCall("gained", {\n\t\t\t\t\tby: deltaRequester,\n\t\t\t\t\tbody: { declare: [], body: [inserting(gained.statement, headingOf(gained))] }\n\t\t\t\t}),\n\t\t\t\t...lost\n\t\t\t]\n',
				why: "A delta form's gain runs before its removal: a fact the write changed at one key of the stored relation meets the withdrawn fact still standing there, its insert a conflict on the key that inserts nothing, and the removal then deletes the withdrawn fact, the relation left without the fact its definition gives (the kept case)."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\t\t...arms.filter(meets).map((a): InferredExpr => ({",
				replacement: "\t\t\t\t\t\t...arms.slice(0, 0).map((a): InferredExpr => ({",
				why: "A lost rule deletes every candidate unchecked: a visit's row deleted where a suspension of the same session and instant derives Standing's fact of that tag too deletes the fact, which the suspension still derives."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\tif (free.length === 0) {\n\t\treturn { fact: derived, vars: [], matches: [] }\n\t}\n",
				replacement:
					"\tif (free.length >= 0) {\n\t\treturn { fact: derived, vars: [], matches: [] }\n\t}\n",
				why: "A candidate whose fact reads a field only a match its relaxation drops binds taken as the fact, read neither from the stored table nor refused: a visit's delete under Pairs' join at its session leaves the suspension's instant free, and its lost rule's head reads a variable no match binds, which the installation's compile refuses."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\t\tfor (const side of sidesOf(u, r, bothSides)) {",
				replacement: '\t\tfor (const side of sidesOf(u, r, ["removed"])) {',
				why: "A checked form reads a holder's removed rows alone for what a write withdraws: an end inserted under a standing visit, which Standing's rule negates, withdraws its fact, which the table keeps."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original: "\t\t\tconst gained = gainedQuery(u, c.arms, bothSides)",
				replacement: '\t\t\tconst gained = gainedQuery(u, c.arms, ["added"])',
				why: "A checked form reads a holder's added rows alone for what a write gains: a suspension deleted under a visit of its session gives Standing back the visit's fact, which its table never holds again."
			},
			{
				file: "packages/engine/src/analysis/theory/upkeep.ts",
				original:
					'\t\t\t\t...arm.negated.flatMap((n) => (n.source.kind === "relation" ? [n.source.name] : []))',
				replacement: "\t\t\t\t...[]",
				why: "A delta form reads no write of a relation its definition negates alone: an end inserted under a standing visit withdraws Standing's fact of it, which its table keeps."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\t...nettingsOf(b.schema, sides),\n",
				replacement: "\t\t\t\t\t...nettingsOf(b.schema, []),\n",
				why: "The judge nets no side of news: a data step that inserts a visit and deletes it again leaves its image in the delta, and the gained rule reads the pair it would derive, which Pairs' table then keeps with no visit standing for it."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\t\t\t\tonConflict: {\n\t\t\t\t\t\tkind: "columns",\n\t\t\t\t\t\tcolumns: mapNonEmpty(kept.primaryKey, columnOf),\n\t\t\t\t\t\taction: { kind: "doNothing" }\n\t\t\t\t\t},',
				replacement: "\t\t\t\t\tonConflict: undefined,",
				why: "An upkeep inserts every fact it derives, a fact its table holds among them: a second row deriving a pair Pairs holds, or two rules deriving one, refuses the COMMIT on the table's primary key (23505)."
			}
		]
	})
