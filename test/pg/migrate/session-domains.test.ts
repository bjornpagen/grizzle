/**
 * A migration that drops, retypes or tightens a domain commits on PostgreSQL 19 while a session that wrote through it
 * rests in its pool, holding the write's carrier: a session's own objects hold their values by their session types,
 * never an installation's domain (ir/physical.ts sessionTypeRef, write/carriers/carriers.ts CarrierDeclaring), so no
 * statement of the migration depends on another session's temporary table.
 *
 * A case installs the notes, `Note(k, n)`, `n` of the contract Words over integer at least 0, mutable inside the unit
 * of their key, and the login `desk` of a writer serving a put of the notes from a relation parameter, whose deletion
 * and insert read the parameter's rows from a carrier; opens a Db of the writer and puts a note, which stands the
 * carrier up in its pooled session; then migrates to a version that changes Words: its least value raised to 1, its base
 * widened to bigint (converted by the reviewer's cast), or the field `n` dropped with it (declared).
 *
 * Oracle: PostgreSQL itself. The migration commits. Typed by Words, the carrier's column would fail each: a drop of the
 * domain refused 2BP01 ("column c2 of table pg_temp_N.__carrier_1_... depends on type"), a constraint added to it
 * refused for "cannot access temporary tables of other sessions".
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

/** A migration that drops, retypes or tightens a domain commits while a session holding a carrier written through it lives. */
export const aMigrationThatDropsRetypesOrTightensADomainCommitsWhileASessionHoldingACarrierWrittenThroughItLives =
	property.exhaust(finite(domainCases), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a migration that tightened a domain a live carrier holds",
			"a migration that retyped a domain a live carrier holds",
			"a migration that dropped a domain a live carrier holds",
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
			name: "PostgreSQL's acceptance of every statement of the migration while the carrier's session lives"
		},
		box: "each change of Words (its least value raised, its base widened, the field dropped with it), with and without another client's temporary table of Words",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/physical.ts",
				original: "\t\t: baseTypeRef(names, t)\n",
				replacement: "\t\t: fieldColumnType(names, t).type\n",
				why: "A session object's column is typed by its field's domain again, a carrier's among them: the migration that drops Words, or replaces it to tighten or widen it, is refused 2BP01 at its drop of the domain the live session's carrier depends on."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/errors.ts",
				original: '\tArr.some(Str.split("\\n")(failure.detail), namesTemporary)\n',
				replacement: '\tArr.some(Str.split("\\n")(failure.detail), () => false)\n',
				why: "A drop another client's temporary table refuses is reported as drift, pointing the operator at grizzle drift, which finds nothing, where the cause is a live session."
			}
		]
	})
