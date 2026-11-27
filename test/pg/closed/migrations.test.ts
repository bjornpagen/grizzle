/**
 * Roster migrations on PostgreSQL 19, run as programs of a commands machine against a model of the roster's history.
 *
 * The model is A8's roster machine (test/support/closed/generate.ts rosterMachine: grow, remove, re-add, and a reorder
 * it refuses), a list of code slots replayed command by command that shares no code with the engine's codebook,
 * extended with what the installation stores: the codes of Held's rows, the sets of a Sets relation once a command adds
 * it, and the rows of two closed relations under a closed-only law. Each step is one schema edit, drafted from the
 * snapshot before it as `grizzle generate` drafts it and applied by the real runner:
 *
 * - **grow, re-add:** the roster takes the next code; a set column widens to bit(n′) where its codes pass a whole hex
 *   digit, and keeps every stored set;
 * - **remove:** the handle's code becomes a hole. Where a row or a set still holds it, the domain's VALIDATE fails with
 *   23514 naming the table and the column of each, unless the data step was drafted as a custom migration applied
 *   with the removal, before it; after a refusal the data step runs and the migration applies. VALIDATE fails exactly when the model says a row holds the
 *   removed code and no data step ran, and names exactly the columns that hold it;
 * - **reorder:** refused before anything is drafted, naming the pair it puts out of their codes' order, which the model
 *   names too; nothing changes;
 * - **a removal whose drop is undeclared:** refused before anything is drafted (UndeclaredDrop), naming the handle, since
 *   a hole is data a migration loses and only `--drop Roster#handle` loses it; nothing changes;
 * - **write, write a set, add Sets:** a direct writer stores a live code or a set of live handles, or the schema gains
 *   Sets, a set over the roster;
 * - **regenerate:** no change drafts nothing, and the snapshot is the previous one;
 * - **closed rows:** the rows of Allowed and Edge change, under `contained(on(Edge, from), on(Allowed, node))`, a law
 *   whose sides are closed relations only, which the migration discharges once: rows that break it fail the migration
 *   with 23000 naming the law, and leave the catalog and the ledger as they were.
 *
 * After every step the installation must be the model's (the oracle is PostgreSQL's catalog and verdicts against the
 * model): each roster domain's CHECK reads one live-codes constant, which holds the model's live codes as a set's bits, a
 * hole's bit 0, and whose name changes exactly when its live codes change (a content address); the schema's names
 * constants hold exactly each roster's names in code order, a hole the empty name, every replaced one dropped; Held's
 * codes and Sets' bit strings are the model's, and the host decodes each to the model's handles.
 *
 * The roster is drawn by A8's generator in spellings a swarm picks per case, so its handles meet an array literal's
 * quoting (`NULL`, a comma, a quote, a brace, a 63-byte multibyte name). Each case's commands are a swarm drawn per case
 * (testing doctrine, rule 7); the all-off draw is guarded by keeping `write`, which applies in every state, always on,
 * so no program stalls. Bound: programs of one to six steps over a roster installed with two to four handles. A data
 * step drafted is a custom migration (README, Data steps) applied with the removal, before it, and one run after a
 * refusal runs in a transaction of its own inside the guard bracket over the table it writes (physical/ddl/immutable.ts
 * guardBracket): a closed relation's rows are removed by that bracket alone.
 *
 * Features: a handle grown, removed and declared again, a reorder and an undeclared drop refused, VALIDATE refusing a
 * removed code a row holds and a removed bit a set holds, a data step drafted, a set column widened and a set stored,
 * nothing drafted, and closed rows changed and refused by their law.
 */

import { defined } from "@bjornpagen/testing/assert"
import { runProgram } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Built,
	builtOf,
	type Feature,
	initialOf,
	machine,
	real,
	runGen,
	sameAsModel,
	type System
} from "#test/pg/closed/migrations.fixtures.ts"
import { liveOf } from "#test/support/closed/generate.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import {
	baseSubstrate,
	claimsOfNoFact,
	Substrate,
	worldSession
} from "#test/support/substrate/substrate.ts"

/** Roster migrations on PostgreSQL 19 every migration of a roster's history leaves the installation the model's, and VALIDATE and the closed-only law refuse exactly what the model refuses. */
export const rosterMigrations = property.explore(steered(runGen), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a handle grown",
		"a handle removed",
		"a removed name declared again",
		"a reorder refused",
		"an undeclared drop refused",
		"VALIDATE refused a removed code a row holds",
		"VALIDATE refused a removed bit a set holds",
		"a data step drafted",
		"a set column widened",
		"nothing drafted",
		"closed rows refused by their law",
		"closed rows changed"
	] satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 6, coverage cases 24 (migrations.test.ts at bf4f43bb). */
	budget: { runs: 6, steered: 24 },
	check:
		({ caseSubstrate }, kase: Case<Feature>) =>
		(run) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						const initial = initialOf(run.installed)
						const builds: Array<Built> = []
						const m = yield* migrated({
							label: "closed_migrations",
							schemaName: { kind: "unique" },
							first: (name) => {
								const b = builtOf(name, initial, liveOf(initial.tier))
								builds.push(b)
								return b.version
							},
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: noObservation
						})
						const first = defined(builds[0], "the first version")
						const substrate = yield* Substrate
						const writer = yield* substrate.session({
							...worldSession(m.world(first.writer), claimsOfNoFact),
							label: "writer"
						})
						const sys: System = {
							m,
							writer,
							first,
							snapshot: m.snapshot,
							names: m.names,
							folders: [],
							drafts: m.folders.length,
							ids: 0,
							constants: new Map()
						}
						yield* sameAsModel(sys, initial)
						yield* runProgram(
							machine(initial),
							real(sys, (f) => kase.note(f)),
							run.program
						)
					})
				),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "the catalog and every verdict against A8's roster history model"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/closed/migrations.test.ts#rosterMigrations:fff.0:0.0.0.0.0.0.0.0"
			),
			reason:
				"a roster of two handles, Open and Done, grown by Held, no set: its step folder sorts after its installed history's on the tests' one clock, where an install drafted a day after the steps' epoch refused it (FolderRefused, sorts before the applied install folder)",
			since: "2026-11-20"
		}
	],
	kills: [
		{
			file: "test/support/install-migrate.ts",
			original: "\t\t\t\ttimestamp: draftedAt(at.step),\n",
			replacement: "\t\t\t\ttimestamp: draftedAt(at.step + 86_400),\n",
			why: "An installed history drafted on a clock of its own, a day after the one its fixtures draft on (537c8739e's installInstant): the kept growth's step folder sorts before the install folder and the migration is refused at its order stage."
		},
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\tthis.sql("publish.validate", [\n\t\t\t\t{\n\t\t\t\t\tkind: "alterDomain",\n\t\t\t\t\tname: create.name,\n\t\t\t\t\taction: { kind: "validateConstraint", name: b.name }\n\t\t\t\t}\n\t\t\t])\n',
			replacement: "",
			why: "A domain's new CHECK added NOT VALID and never validated, which would apply a removal over rows that still hold the removed code; migrate's drift check finds the CHECK not validated first."
		},
		{
			file: "packages/engine/src/ir/codes.ts",
			original: '\t\tif (name !== "") {',
			replacement: "\t\tif (true) {",
			why: "A roster's live-codes constant sets a hole's bit: after a removal its domain's CHECK admits the removed code, and the constant the CHECK reads holds bits the model's live codes do not."
		}
	]
})
