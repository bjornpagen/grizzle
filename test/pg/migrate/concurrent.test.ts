/**
 * Installations migrating into one database at once (DEFACL). Each is a schema of its own, but they write catalog rows
 * they share: the owner's global default privileges (one pg_default_acl row per owner and object kind), the vector
 * extension's schema's ACL, the database's ACL. Every statement that writes one is the database lock's
 * command and its own (packages/engine/src/sql/print.ts databaseWide); without the lock two of them at once fail with
 * XX000 (tuple concurrently updated), as installations did when test seats installed at once (2484d498), and a lock
 * printed into the same text as its statement fails every door that sends one command a message (42601, 2f3f4a14).
 *
 * A case draws two or three installations, each the first migration of one of two shapes, a relation keyed by id with
 * a Boolean field or with a vector field, which one role of one login reads, so a vector installation grants USAGE on
 * the vector extension's schema; and each sent through one of the two doors a drafted statement reaches PostgreSQL by:
 * the real apply runner over its drafted folder (install-migrate.ts migrateFolders, as `grizzle migrate` and every
 * migrated or served test installation send it, a file split into its commands), or the harness's script door (one
 * transaction of filledSql over the fresh-install script, as installRealSchema and installationSql send it, one
 * command a message). Each is drafted as `grizzle generate` drafts it (generatedDraft), under a name of its own and the
 * case's one owner, and sent as an owner login of its own (ambientOwner), all of them at once into the file's database.
 *
 * The construction: before any is sent, a gate session opens a transaction and creates each installation's login role,
 * uncommitted. An installation creates that role among its publish statements, before its grants and its default
 * privileges, so it waits there on the gate (pg_authid's unique name). Once every installation's backend waits on a
 * lock, on the gate or on an installation that holds the database lock and waits on the gate, the gate rolls back and
 * they run on together into their grants and default privileges.
 *
 * The oracle is PostgreSQL. Fresh installations hold no row, so no law refuses a statement of theirs: every
 * installation is sent whole; each holds the installed-catalog posture (checkInstallation) and a migrated one the
 * catalog of its fresh install (expectFreshCatalog); and the rows they share hold what each of them wrote: the owner's
 * global default privileges on functions and types grant PUBLIC nothing, and each vector reader holds USAGE on the
 * vector extension's schema.
 *
 * Features: two installations waiting on the gate at once, each inside its publish statements; two installations of a
 * case granting on the vector extension's schema; the two doors in one case; three installations at once. Each is
 * aimed at while pending.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { aims, caseGen, type Feature, walk } from "#test/pg/migrate/concurrent.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Installations migrating into one database at once every installation sent at once, by either door, installs whole, and the rows they share hold what each wrote. */
export const concurrent = property.explore(aimed(caseGen, aims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"two installations waiting on the gate at once, each inside its publish statements",
		"two installations granting USAGE on the vector extension's schema at once",
		"an installation sent by the real runner beside one sent by the harness's script door",
		"three installations at once"
	] satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 6, coverage cases 8 (concurrent.test.ts at bf4f43bb). */
	budget: { runs: 6, steered: 8 },
	check:
		({ substrate }, cx: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				Effect.scoped(walk(c, cx.note)),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "PostgreSQL: every installation sent whole, each at its fresh install's catalog and posture, and the owner's global defaults and the vector schema's grants as each installation wrote them"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/sql/print.ts",
			original:
				"const databaseWide: Emitter = (command) => [(out) => writeCommand(out, databaseLock), command]",
			replacement: "const databaseWide: Emitter = (command) => [command]",
			why: "databaseWide emits a statement's own command alone, so a setup is refused with XX000 on the database default."
		},
		{
			file: "packages/engine/src/sql/print.ts",
			original:
				"const databaseWide: Emitter = (command) => [(out) => writeCommand(out, databaseLock), command]",
			replacement:
				"const databaseWide: Emitter = (command) => [\n\t(out) => {\n\t\tterminated(out, (lines) => writeCommand(lines, databaseLock))\n\t\tcommand(out)\n\t}\n]",
			why: "The lock and its statement one command, as 732aa5b2 printed them, so the script door is refused with 42601."
		}
	]
})
