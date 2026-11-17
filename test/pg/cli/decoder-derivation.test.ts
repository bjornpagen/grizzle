/**
 * On PostgreSQL 19, through the command line: an installation an earlier grizzle migrated, its decoder login, its
 * publication and its replication slot named as that grizzle's naming door named them, migrated by today's grizzle
 * across the change.
 *
 * e1c1fc23 changed the live source's name, which names the decoder login, the publication and the slot, from
 * `__live_<segments>_<digest>` to `__live_<digest>`. A case generates the shop (test/pg/cli/fixture.ts shopV1: the
 * login `server`, its roles `reader` and `writer`, whose read of a customer gives the installation a live source) under
 * an allocated role prefix, then spells the whole committed output as an earlier grizzle drafted it: the live source's
 * name `__live_<digest>` becomes `__live_<segments>_<digest>`, its segments drawn, in every folder file, the snapshot's
 * two files, the served files and meta.json, with the snapshot's fingerprint made again over its content
 * (snapshot/build.ts snapshotFingerprint) and meta.json sealed again (deploy/render/folder.ts writeMeta). It migrates
 * that output into a fresh database, gives the decoder login a password as an operator does, makes a replication slot
 * under the decoder login's name where drawn, as the earlier leader made one, and writes a customer. Then today's
 * `grizzle generate` drafts the next migration, under the same workload or one more program, which drafts an index
 * beside the rename, and `grizzle migrate` applies it.
 *
 * Properties, each against its oracle:
 * - Roles: `grizzle roles` lists exactly the roles roleNameOf names off today's served values under the prefix: the
 *   served login, each of its roles, and the decoder login. The decoder login is the role the earlier output created,
 *   by its OID, so its password and its replication right are the ones it held.
 * - Live source: no slot is left of the earlier name and no publication but the one today's served file names. A live
 *   read of the reader through today's served file, its live source logging in as the decoder login with the password
 *   it was given before the migration, reads the customer written before, then streams one written after it.
 * - Drift: `grizzle drift` passes.
 * - Uninstall: `grizzle uninstall` leaves no role under the prefix, no slot in the database and no publication. It
 *   runs once the live read's layer has closed and the leader's walsender has let its slot go, as an operator stops
 *   the leaders first: PostgreSQL refuses to drop a slot a walsender holds (55006), and a walsender outlives its
 *   client's close by however long the server takes to see it.
 *
 * Oracles: the naming door's own names for today's served values (roleNameOf), PostgreSQL's catalogs, the decoder
 * login's OID before the migration, and the customers the case wrote.
 *
 * Features: a slot the earlier leader made, and none; the rename alone, and beside a schema change.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	earlierCase,
	type EarlierFeature,
	earlierGen
} from "#test/pg/cli/decoder-derivation.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** An installation migrated by an earlier grizzle, its live source named as that grizzle named it migrate across the change of the live source's name: the decoder login renamed in place, its slot and publication replaced, its live source streaming, and uninstall leaving nothing. */
export const decoderDerivation = property.explore(earlierGen, {
	needs: { substrate: Substrate.installing },
	situations: [
		"a slot the earlier leader made",
		"no slot",
		"the rename alone",
		"the rename beside a schema change"
	] satisfies ReadonlyArray<Reached<EarlierFeature>>,
	/** Its pre-conversion budget: runs 8, coverage cases 8 (decoder-derivation.test.ts at bf4f43bb). */
	budget: { runs: 8, steered: 8 },
	check:
		({ substrate }, c: Case<EarlierFeature>) =>
		(value) =>
			Effect.provideServiceEffect(earlierCase(value, c), Substrate, substrate),
	oracle: {
		kind: "specification",
		name: "roleNameOf of today's served values, PostgreSQL's catalogs and the decoder login's OID"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original: "\tif (from === undefined || to === undefined || from === to) {",
			replacement: "\tif (from === undefined || to === undefined || from === to || from !== to) {",
			why: "The diff carries no decoder rename, so it drops the earlier decoder login and creates today's; the roles property fails, the decoder login's OID changed."
		},
		{
			file: "packages/engine/src/core/identity.ts",
			original: "\t\t!segments.every(isSegment)",
			replacement: "\t\tsegments.length > 0",
			why: "A variable reads only today's hashed role forms, so migrate of the earlier output is refused at stage input."
		}
	]
})
