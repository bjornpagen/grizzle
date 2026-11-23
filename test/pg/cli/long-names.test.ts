/**
 * On PostgreSQL 19: a login's and its roles' PostgreSQL roles and schemas as the installation names them, at the
 * identifier limit, through the command line, generated.
 *
 * A login's or role's PostgreSQL role joins its schema's name and its own (core/identity.ts), and must fit 63 bytes:
 * PostgreSQL would cut a longer one, and Db.open would look for a role no migration created. A caller never spells one:
 * roleNameOf and schemaNameOf (program/names.ts) name each from its value. A case draws a login and one to three roles
 * over one relation, each name lowercase words or camel case, which the naming door converts, so the longest
 * PostgreSQL role is the login's or a role's; a schema name (substrate/names.ts uniqueSchemaNameOfLength) whose longest
 * role fills exactly 63 bytes, or one byte more; and a spelling of the schema's declared name, each of its letter
 * segments lowercase, capitalized or in capitals, which converts back to the allocation. The rule and the catalog are
 * the oracles:
 *
 * - schemaNameOf of the schema is the allocation, however its declared name is spelled;
 * - at 63 bytes, `grizzle generate` drafts, `grizzle check` passes and `grizzle migrate`, with the configuration's
 *   connection, applies it; the installed schema is the allocation; the roles the catalog holds under the allocation
 *   are exactly roleNameOf of the login, which alone logs in, and of every role, and, its roles holding whole entries
 *   alone, it holds no role's schema there, and the schema of the whole views they read is wholeSchemaNameOf of the
 *   schema; and Db.open of every role, its layer given the served file generate wrote and the
 *   password of roleNameOf of the login, logs in and is admitted;
 * - one byte past, `grizzle generate` refuses the name as too long and drafts nothing, and roleNameOf refuses
 *   (IdentifierTooLong) exactly the worlds whose role passes 63 bytes.
 *
 * Features: the login's role the longest and a role's, a converted camel-case name, a schema spelled apart from its
 * conversion, at the limit and one byte past.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { limitCase, type LimitFeature, namesGen } from "#test/pg/cli/long-names.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** Logins and roles at the identifier limit, through the command line install roles of exactly 63 bytes, each the one roleNameOf names and admitted by Db.open, and refuse a schema name one byte longer, for drawn logins, roles and schema spellings. */
export const longNames = property.explore(namesGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"the login's role the longest",
		"a role's role the longest",
		"a converted camel-case name",
		"a schema spelled apart from its conversion",
		"at the limit",
		"one byte past"
	] satisfies ReadonlyArray<Reached<LimitFeature>>,
	/** Its pre-conversion budget: runs 4, coverage cases 16 (long-names.test.ts at bf4f43bb). */
	budget: { runs: 4, steered: 16 },
	check:
		({ substrate }, c: Case<LimitFeature>) =>
		(value) =>
			Effect.provideServiceEffect(
				limitCase(value, c),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "the 63-byte rule for <schema>__<name>, and PostgreSQL's own roles and schemas"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/core/identity.ts",
			original: "\tif (bytes > maxIdentifierBytes) {",
			replacement: "\tif (bytes > maxIdentifierBytes + 1) {",
			why: "The 63-byte rule admits a login's or role's PostgreSQL role of 64 bytes, so one byte past the limit generate drafts where it must refuse."
		}
	]
})
