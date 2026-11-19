/**
 * Every write to a grizzle table runs at SERIALIZABLE (a direct SQL writer must use SERIALIZABLE), as a model
 * over the whole small box of planted writers.
 *
 * One schema of four relations, one per kind of table a writer meets: a law-bearing mutable relation (Team, the target
 * of a foreign key and the relation of a row check), a law-bearing immutable one (Member, the foreign key's source),
 * and a lawless immutable and mutable one (Note, Tag). Every law is native, so a table's guard is its one trigger.
 *
 * The planted premise: before the installation, the database names no default level, so a new session runs
 * PostgreSQL's own, READ COMMITTED; the installation must set the database's default to SERIALIZABLE itself.
 *
 * Every point of the box is a transaction: a level (the database's default, which a transaction begun with no level
 * takes, SERIALIZABLE, READ COMMITTED, REPEATABLE READ, READ UNCOMMITTED), an actor (the `writer`, a session in the
 * schema's full world, granted every write grizzle grants, or the schema's owner, who holds every privilege), a
 * statement (an INSERT, an UPDATE, a DELETE of one row, a DELETE of no row, a TRUNCATE ... CASCADE, a MERGE that
 * inserts, a MERGE that updates, a MERGE that deletes, a SELECT) and a table, and a write's transaction reads its table
 * first or not, since a guard fires at the write whatever the transaction read. The model names its outcome from that
 * point alone, in the order PostgreSQL meets each refusal:
 *
 * - a SELECT is admitted at every level, and its transaction commits;
 * - the privilege check at executor start comes first: the writer's TRUNCATE (granted to no one) and its UPDATE of an
 *   immutable relation, plain or a MERGE's, are 42501 at every level;
 * - then the table's guard, a BEFORE statement trigger that fires whatever rows the statement matches: below
 *   SERIALIZABLE every other write is 25000, its SCHEMA and TABLE fields naming the table, and the transaction's COMMIT
 *   is answered with ROLLBACK, so it commits nothing;
 * - at SERIALIZABLE, and at the database's default, which the installation set to it, every other write runs (each
 *   transaction then rolls back, so every point starts from one state).
 *
 * That every table, the migrations ledger included, carries exactly one guard, BEFORE every write, per statement and
 * enabled, and that the database's settings name SERIALIZABLE, is the installed-catalog checker's, which every
 * installation runs (test/support/catalog/installed.ts).
 *
 * A case that resets a database setting runs in a database of its own (Substrate.fresh).
 *
 * - Property: at every point of the box, the outcome PostgreSQL gives is the model's, and every table holds its starting
 *   rows after the point (a refusal that wrote anyway, or an admitted write that committed, fails).
 * - Oracle: the specification turned into a checker (predict), the README's refusal order over the point.
 * - Features: each statement under each verdict, the guard's refusal on each kind of table and after a read, and a write
 *   admitted at the database's default.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	box,
	guardedTemplate,
	installedDefault,
	type IsolationFeature,
	pointCase,
	priorDefaults,
	situations
} from "#test/pg/direct-writers/isolation.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A write below SERIALIZABLE is refused with 25000 naming its table, after privilege, the database's default being the
 * SERIALIZABLE the installation set; a read is admitted: every point of the box on the worker's seat of Guarded,
 * installed and loaded once per member.
 *
 * Its pre-conversion budget: the box (test/pg/direct-writers/isolation.test.ts at 38aeb4606).
 */
export const aWriteBelowSerializableIsRefusedWith25000NamingItsTableAfterPrivilegeAndAReadIsAdmitted =
	property.exhaust(finite(box), {
		needs: { guarded: Substrate.seat(guardedTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<IsolationFeature>>,
		check:
			({ guarded }, c: Case<IsolationFeature>) =>
			(point) =>
				Effect.scoped(
					Effect.flatMap(guarded, (seat) =>
						Effect.provideService(pointCase(seat.value, point, c), Substrate, seat.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "the README's refusal order restated (predict): a read admitted, then privilege, then the guard below SERIALIZABLE"
		},
		box: "every level (the database's default, SERIALIZABLE, READ COMMITTED, REPEATABLE READ, READ UNCOMMITTED), actor (a world role's writer, the schema's owner), statement (INSERT, UPDATE, DELETE of a row and of none, TRUNCATE, MERGE inserting, updating and deleting, SELECT), table (law-bearing or lawless, mutable or immutable), and for a write a read of its table first or none",
		kept: [],
		kills: []
	})

/**
 * The installation sets the database's default to SERIALIZABLE, whatever default it found: each prior default a case of
 * its own on a database of its own (Substrate.fresh), installed after it. The search asserted this premise once, from no
 * default, before its box; a template's clone takes the default its build left, so the premise is a property of its
 * own, over every default below SERIALIZABLE.
 *
 * Its pre-conversion budget: the search's one premise (test/pg/direct-writers/isolation.test.ts at 38aeb4606).
 */
export const theInstallationSetsTheDatabasesDefaultToSerializable = property.exhaust(
	finite(priorDefaults),
	{
		needs: { own: Substrate.fresh },
		situations: [],
		check:
			({ own }) =>
			(prior) =>
				Effect.provideServiceEffect(Effect.scoped(installedDefault(prior)), Substrate, own),
		oracle: {
			kind: "postgresql",
			name: "SHOW default_transaction_isolation in a new session, before the installation and after it"
		},
		box: "every default a database may name before the installation: none, READ COMMITTED, REPEATABLE READ, READ UNCOMMITTED",
		kept: [],
		kills: []
	}
)
