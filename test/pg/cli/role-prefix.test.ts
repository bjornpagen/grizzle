/**
 * On PostgreSQL 19: one committed `grizzle generate` output installed into two databases of one cluster, each under its
 * own role space, through the command line.
 *
 * PostgreSQL's roles are the cluster's and an installation is one database's, so an installation is its database and
 * its role prefix (DbConnection.rolePrefix). A case draws the second installation's role space, another prefix or
 * none, beside the first's prefix, and whether a role of the first holds a privilege on an object of another database
 * when it is uninstalled. It generates the shop (test/pg/cli/fixture.ts shopV1: the login `server`, its roles `reader` and
 * `writer`) once, then migrates the one output into two fresh databases (test/support/pg.ts freshDatabase), each
 * configuration's connection naming its database and its prefix. Every prefix is an allocated name
 * (test/support/substrate/names.ts uniqueSchemaName), so a role a dead run leaves is the sweep's.
 *
 * Properties, each against its oracle:
 * - Disjoint: `grizzle roles` of each installation is exactly every role it creates as roleNameOf names it under its
 *   connection, read off the values and never a hand list: the served login's, each role of the login's, and the
 *   decoder login its served file names (oracle: the stem each value carries under core/identity.ts roleInSpace, which
 *   is the naming door's for no prefix); each fits PostgreSQL's 63 bytes, and the two lists share no name.
 * - Its own database only: each installation's writer inserts a customer through its layer, over its database under
 *   its prefix, and its reader reads it back; the other installation reads no such customer; a layer of one
 *   installation's login over the other's database is refused.
 * - Uninstall: while a role of the first holds USAGE on a schema of another database, which uninstall's DROP OWNED, run
 *   in its own database, cannot revoke (it revokes a privilege on a shared object, CONNECT on any database among them,
 *   so that one would not hold the role), `grizzle uninstall` is refused at stage uninstall with PostgreSQL's 2BP01 and
 *   drops nothing (its roles listed as before, `grizzle drift` still passing).
 *   Then it drops exactly the installation: its schema and its roles' schemas, and its roles, `grizzle roles` printing
 *   none; the second installation's roles are all there and its reader still reads; and a bystander role under the
 *   first's prefix over another schema, outside its namespace, stays.
 *
 * - Whatever derived its names: where the first installation's decoder login, its publication and its slot carry the
 *   names an earlier derivation gave them (e1c1fc23 renamed `__live_<segments>_<digest>` to `__live_<digest>`), as an
 *   installation an earlier grizzle migrated holds them, uninstall drops them all as the cluster names them, and no
 *   role is left under the first's prefix but the bystander, no slot in its database and no publication.
 *
 * Features: the second installation under another prefix, and under none; an uninstall refused, then done; a decoder
 * named by an earlier derivation.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { spaceCase, type SpaceFeature, spacesGen } from "#test/pg/cli/role-prefix.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Two installations of one generated output on one cluster, each under its own role space install one output into two databases under disjoint role spaces, each working against its own database only, and uninstall exactly one of them, refused whole while a role is held elsewhere. */
export const rolePrefix = property.explore(spacesGen, {
	needs: { substrate: Substrate.installing },
	situations: [
		"the second under another prefix",
		"the second under no prefix",
		"an uninstall refused, then done",
		"a decoder named by an earlier derivation"
	] satisfies ReadonlyArray<Reached<SpaceFeature>>,
	/** Its pre-conversion budget: runs 4, coverage cases 8 (role-prefix.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 8 },
	check:
		({ substrate }, c: Case<SpaceFeature>) =>
		(value) =>
			Effect.provideServiceEffect(spaceCase(value, c), Substrate, substrate),
	oracle: {
		kind: "specification",
		name: "roleNameOf under each installation's role space, and PostgreSQL's own roles and grants"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/identity.ts",
			original:
				"\treturn at > 0 && levels.has(stem.slice(0, at)) && isConversion(stem.slice(at + 2))",
			replacement: "\treturn at > 0 && isConversion(stem.slice(at + 2))",
			why: "Uninstall takes every role under the prefix for the installation's, so it drops the bystander outside its namespace; the uninstall property fails."
		},
		{
			file: "packages/engine/src/sql/print.ts",
			original: '\tgrantee.kind === "PUBLIC" ? "PUBLIC" : printRole(grantee.name)',
			replacement: '\tgrantee.kind === "PUBLIC" ? "PUBLIC" : quoteIdent(grantee.name)',
			why: "The printer prints a grant's role by its stem, bypassing its variable, so a grant under a prefix names a role the installation never created."
		},
		{
			file: "packages/engine/src/deploy/render/variables.ts",
			original: "\t\tResult.map(roleInSpace(names.roles, variable.name), quoteIdent),",
			replacement:
				"\t\tResult.map(Result.flatMap(roleInSpace(names.roles, variable.name), (once) => roleInSpace(names.roles, once)), quoteIdent),",
			why: "Migrate fills a role variable with the prefix twice, so the installation's roles are created under a name roleNameOf never gives."
		}
	]
})
