/**
 * A migration that drops, retypes or tightens a domain commits on PostgreSQL 19 while a session that wrote through it
 * rests in its pool, holding the rule judge's deltas of what it wrote: a session's own objects hold their values by
 * their session types, never an installation's domain (ir/physical.ts sessionTypeRef, physical/ddl/deltas.ts
 * sessionDeltaOf), so no statement of the migration depends on another session's temporary table.
 *
 * A case installs the notes, `Note(k, n)`, `n` of the contract Words over integer at least 0, and the marks, each
 * mutable inside the unit of their key, with Marked, each note of a negative key at a mark of its key, which the rule
 * judge holds; and the login `desk` of a writer serving a put of the notes from a relation parameter; opens a Db of the
 * writer and puts a note, which stands the judge's deltas of the notes up in its pooled session, `n` a column of them;
 * then migrates to a version that changes Words, with Marked gone: its least value raised to 1, its base widened to
 * bigint (converted by the reviewer's cast), or the field `n` dropped with it (declared).
 *
 * Oracle: PostgreSQL itself. The migration commits. Typed by Words, a delta's column would fail each: a drop of the
 * domain refused 2BP01 ("column n of table pg_temp_N.__delta_... depends on type"), a constraint added to it refused
 * for "cannot access temporary tables of other sessions".
 *
 * The box, exhausted: each change.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	domainCases,
	type SessionDomainFeature,
	sessionDomainCase
} from "#test/pg/migrate/session-domains.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A migration that drops, retypes or tightens a domain commits while a session holding judge deltas written through it lives. */
export const aMigrationThatDropsRetypesOrTightensADomainCommitsWhileASessionHoldingJudgeDeltasWrittenThroughItLives =
	property.exhaust(finite(domainCases), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a migration that tightened a domain a live judge delta holds",
			"a migration that retyped a domain a live judge delta holds",
			"a migration that dropped a domain a live judge delta holds",
			"a migration refused for another client's temporary table, naming it"
		] satisfies ReadonlyArray<Reached<SessionDomainFeature>>,
		check:
			({ substrate }, c: Case<SessionDomainFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					sessionDomainCase(k, c),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's acceptance of every statement of the migration while the deltas' session lives"
		},
		box: "each change of Words (its least value raised, its base widened, the field dropped with it), with and without another client's temporary table of Words",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/physical.ts",
				original: "\t\t: baseTypeRef(names, t)\n",
				replacement: "\t\t: fieldColumnType(names, t).type\n",
				why: "A session object's column is typed by its field's domain again, a judge delta's among them: the migration that drops Words, or replaces it to tighten or widen it, is refused 2BP01 at its drop of the domain the live session's delta depends on."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/errors.ts",
				original: '\tArr.some(Str.split("\\n")(failure.detail), namesTemporary)\n',
				replacement: '\tArr.some(Str.split("\\n")(failure.detail), () => false)\n',
				why: "A drop another client's temporary table refuses is reported as drift, pointing the operator at grizzle drift, which finds nothing, where the cause is a live session."
			}
		]
	})
