/**
 * The apply runner's ledger as a state machine, on PostgreSQL 19.
 *
 * The model is the documented contract: a migrations
 * directory of three drafted folders (Shop v1 to v3: the first drafted beside an abandoned schema, whose rows it leaves
 * behind, a loss only the reviewer decides; a placeholder, a law with its Validate files, a concurrent index in a
 * no-transaction file, a handle appended to a roster, a serial field, removed objects dropped in Publish), and a
 * database whose
 * ledger has recorded some folders, maybe one of them in part. Its state is two numbers: the folders recorded complete,
 * and the files recorded of the next one. Each command is an action a user or a deployment takes, and the model says
 * what it must do:
 *
 * - apply the directory as of folder k: the folders after the recorded ones run, the partial one resumed at its first
 *   unrecorded file; a directory missing an applied or partial folder is refused at `edited`, naming each;
 * - apply folders with a gap, folders that end before the snapshot, or a new folder sorted before an applied one:
 *   refused at `order`;
 * - apply the next folder unreviewed: refused at `marker`, naming exactly the markers its files hold, or, with no marker,
 *   at `decision`, naming exactly the losses of stored data meta.json records, each still commented;
 * - apply with a failing statement before a file, after a no-transaction file, or after a statement inside one:
 *   refused at `statement` at that file, the earlier files recorded, a rerun resuming there;
 * - apply with an applied file edited, deleted, renamed or added, its meta.json edited, or its folder gone: refused at
 *   `edited`, naming each edit;
 * - apply while another apply holds the schema's lock (`busy`), as a role that does not own the schema (`identity`),
 *   with a file that controls its own transaction, or with one schema's folders against another schema's snapshot
 *   (`input`);
 * - a data step a deferred law refuses at COMMIT (`commit`), and a folder that would record before the ledger exists
 *   (`record`).
 *
 * After every command the real database is read back and must be in the state the model claims: the ledger's latest
 * target, its partial folder and the files it recorded, its rows read strictly from the table as the runner reads them;
 * and after every refusal the model says ran nothing, the ledger and the whole catalog are unchanged. Each step draws a
 * command the model's state allows, and its parameters in that state, so every drawn program is a sequence of real
 * actions, and a shrunk one is still one.
 *
 * Oracle: the model, the documented contract as a second implementation, against the real database read back. A list a
 * refusal names is compared as what it is, never by its order: missing folders, markers and edits as sets, losses as a
 * multiset of places, since a file may record several.
 *
 * Features: every command kind, each reached by a generated program.
 */

import { program } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { Effect, Struct } from "effect"
import {
	commandKinds,
	type Feature,
	ledgerShape,
	machineOf,
	runOn
} from "#test/pg/migrate/ledger.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The apply runner's ledger as a state machine programs of the rotating stream, steered until every command is reached: each command leaves the ledger the model claims, and a refusal runs nothing. */
export const ledgerMachine = property.explore(
	program(
		machineOf(ledgerShape),
		{ min: 0, max: 12 },
		fullSwarm(Struct.keys(machineOf(ledgerShape).commands))
	),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: commandKinds satisfies ReadonlyArray<Reached<Feature>>,
		/**
		 * Its pre-conversion budget: runs 3, coverage cases 240 (ledger.test.ts at bf4f43bb: eighty times the rotating
		 * stream's cases, since a refused COMMIT and the failures in the third folder's no-transaction file need two folders
		 * recorded first, a state a program of uniformly drawn commands reaches about one time in twenty).
		 */
		budget: { runs: 3, steered: 240 },
		check:
			({ substrate }, c: Case<Feature>) =>
			(value) =>
				Effect.provideServiceEffect(
					runOn(ledgerShape)(value, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the ledger model, the documented contract as a state machine, against the database read back"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/migrate/plan.ts",
				original: '\t\t\t\truns.push({ kind: "resume", folder, files: filesOf(decision.run) })',
				replacement: '\t\t\t\truns.push({ kind: "resume", folder, files: folder.files })',
				why: "A partial folder resumes at its first file, running again the files the ledger recorded."
			},
			{
				file: "packages/engine/src/deploy/ledger/ledger.ts",
				original: '\tdigest: "digest"\n}',
				replacement: '\tdigest: "text"\n}',
				why: "The hex rendering restored in the ledger: a file's digest is stored as its 64 hex digits, a text, where the ledger stores its 32 bytes, so the ledger's rows read back strictly are no longer the runner's."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: "([standUps, rechecks]) => dataStepBracket(levels, standUps, rechecks)",
				replacement: "([standUps, rechecks]) => dataStepBracket(levels, [], rechecks)",
				why: "A custom migration's data step stands up no rule judge's table before its statements: its write of a table a rule over a query reads is refused at the statement (55Z03), where the data step that breaks the rule is refused at its COMMIT."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: "\t\t\t...Arr.map(bracket.after, (sql) => ({\n\t\t\t\tstage: lawsChecked,\n",
				replacement: "\t\t\t...Arr.map(bracket.after, (sql) => ({\n\t\t\t\tstage: recordStage,\n",
				why: "The bracket's statements after a custom data step's, its deferred laws made immediate, staged as the ledger's rows: the data step that breaks a rule is refused as a record the ledger could not write, at stage record, where its laws refused it as its COMMIT would."
			}
		]
	}
)
