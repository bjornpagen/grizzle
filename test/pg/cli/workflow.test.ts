/**
 * The migration workflow a user runs, as a state machine over the command line, on PostgreSQL 19.
 *
 * The model is the documented loop (docs/operations.md "Migrations", SKILL "The loop" and SKILL "Refusals"): a
 * workspace whose grizzle.config.ts names the shop (test/support/pg/cli/fixture.ts) at version 1 or 2 with its full workload or
 * without its customer lookup, a migrations directory, and a database. Its state: the configuration, what the committed
 * snapshot was generated from, the folders written and the folders applied, the folders whose markers the reviewer has
 * not resolved, and a custom folder whose data step fails.
 * Each command is a step of the loop, run through `runCli` in process exactly as the bin runs it:
 *
 * - configure: a new grizzle.config.ts; `grizzle check` then refuses exactly when the configuration differs from what
 *   the snapshot was generated from;
 * - `grizzle generate`: writes a folder exactly when the configuration changed, its added field's value a placeholder
 *   when the table existed before;
 * - review: the placeholders resolved, the marker lines deleted;
 * - `grizzle check`: passes exactly when everything is generated and resolved, and refuses a configuration not
 *   generated, or an unresolved marker alone once everything is generated, each a command kind of its own;
 * - `grizzle migrate`, with the configuration's connection: refuses before connecting, with nothing run, exactly when
 *   check finds a committed file to fix, here an unresolved marker; it compiles nothing, so a configuration not yet
 *   generated refuses nothing. Otherwise it applies the pending folders, stopping at a custom data step that fails,
 *   which a rerun resumes once fixed, and refuses at its drift check after applying them while a stray table stands in
 *   the schema;
 * - `grizzle drift`: applies nothing, and passes exactly when the latest complete folder's target is the committed
 *   snapshot's configuration, with no partial folder, and the catalog is the snapshot's; a stray table, created behind grizzle's back and dropped after,
 *   is the drift it names;
 * - `grizzle generate --custom` with a data step, failing or not, and the fix of a failing one;
 * - tampering, undone after: snapshot.json or meta.json made unreadable or off the chain (check, migrate and generate
 *   all refuse, nothing written or run), or an applied file edited (migrate refuses, nothing run);
 * - Db.open against the committed snapshot: through the login's served file generate wrote, its first read answers
 *   exactly when every folder up to the last generated one is applied, a custom folder after it keeping the snapshot's
 *   target;
 * - `grizzle migrate` with a wrong password: refused at its connection, nothing run;
 * - scenarios, each a step drawn with the steps that make it reachable: a workload program removed, a placeholder
 *   reviewed, a folder resumed after its failing data step was fixed, a first call answering on a database fully
 *   applied, and one refused on a database a new snapshot is generated over.
 *
 * After every command the real workspace and database are read back and must be what the model claims: the exit code,
 * the folders on disk, the folders the ledger records complete, and after every refusal that runs nothing, the ledger
 * unchanged. Universal: no command ever prints the migration identity's password or a wrong one it was given. What
 * the commands reach is noted through the case the exploration hands the property.
 *
 * The model's commands are pure: whether each applies, what it draws and the state it leaves are judged by the model
 * alone, so a workflow is generated, printed and shrunk as data, and each command's run on the workspace checks the
 * real state against the model's states before and after it.
 *
 * Features: every command kind of the loop, each scenario among them.
 */

import { program } from "@bjornpagen/testing/commands"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { fullSwarm } from "@bjornpagen/testing/swarm"
import { Effect, Struct } from "effect"
import {
	type CommandKind,
	commandKinds,
	runCommands,
	workflow
} from "#test/pg/cli/workflow.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The migration workflow through the command line workflows of the rotating stream, steered until every step is reached: every step's exit code, folders and ledger are the model's, and no password is printed. */
export const commandLineWorkflow = property.explore(
	program(workflow, { min: 0, max: 14 }, fullSwarm(Struct.keys(workflow.commands))),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: commandKinds satisfies ReadonlyArray<Reached<CommandKind>>,
		/** Its pre-conversion budget: runs 3, coverage cases 30 (workflow.test.ts at bf4f43bb). */
		budget: { runs: 3, steered: 30 },
		check:
			({ substrate }, c: Case<CommandKind>) =>
			(steps) =>
				Effect.provideServiceEffect(
					runCommands(c, steps),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the documented loop as a state machine: exit codes, folders on disk and the ledger"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: `\t\t\tfor (const marker of findMarkers(text)) {\n\t\t\t\tat(marker.kind, \`\${where}:\${marker.line}\`, refusalText[marker.kind].problem)\n\t\t\t}\n`,
				replacement: "",
				why: "`grizzle check` finds no unresolved marker, so check passes a committed file the model says it must refuse."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original:
					"\tconst mismatches = [...ledgerMismatches(snapshot, ledger), ...verdict.mismatches]",
				replacement: "\tconst mismatches = [...ledgerMismatches(snapshot, ledger)]",
				why: "The drift check compares no catalog fact, so drift passes while a table created behind grizzle's back stands in the schema."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original:
					"\tfor (const p of planned) {\n\t\tconst verdict = yield* checkDrift(session, p.snapshot, p.statements, p.proofs, p.folders)\n\t\tyield* recordProofs(session, p.snapshot, p.proofs, verdict)\n\t}\n",
				replacement: "",
				why: "The runner skips its drift step: migrate applies its folders and succeeds while a table created behind grizzle's back stands in the schema, which only a later grizzle drift names."
			}
		]
	}
)
