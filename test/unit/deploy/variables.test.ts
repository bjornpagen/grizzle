/**
 * The variables of a drafted migration and their filling (deploy/render/variables.ts resolveVariables), over every statement
 * `grizzle generate` drafts, with no database.
 *
 * A case draws the shop's declared schema name (test/pg/cli/fixture.ts shopV1: the login `server` and its roles
 * `reader` and `writer`, with its workloads), a role space (none or a prefix), a database name, and a variable name
 * of drawn characters. It drafts the first migration through the command line's generate, offline, and reads every
 * statement of every file of the folder as migrate reads them (deploy/render/markers.ts splitStatements).
 *
 * Properties, each against its oracle:
 * - Byte identity of the default: each statement filled under no prefix, its database named DBNAME, is the statement
 *   with the colon of each variable deleted, psql's interpolation of a variable whose value is its name: the printer's
 *   spelling of every role as `"<stem>"` before roles were variables, quoteIdent of the stem at every variable.
 * - A prefix: each statement filled under a prefix p is the statement with each role variable `:"x"` spelled
 *   `"<p>__x"` and the database variable spelled as the database's quoted name, and no variable is left.
 * - Roles are variables: the roles the folder's CREATE ROLEs name are exactly the variables of roleNameOf's stems of
 *   the login and its roles and of the installation's decoder login, the name of its live source (identity.liveSource
 *   of its root), which the shop's reads give it, and no CREATE ROLE names a role any other way.
 * - The variables are DBNAME and a role's names: a statement naming the variable `:"<name>"` under the drawn role space
 *   is filled exactly when the name is DBNAME, a stem (two conversions joined by `__`: lowercase ASCII words, a letter
 *   first, joined by single underscores), the name a migration sets a role aside under while it renames logins
 *   (`__aside_`, then ten characters of lowercase base32) or the installation's live source's, its decoder login's
 *   (`__live_`, the same), within 63 bytes: the forms every committed folder spells, which migrate reads every one of. A
 *   role's name is filled as `"<p>__<name>"` under a prefix p, and refused as roleTooLong past 63 bytes; any other name
 *   is refused as unknownVariable, an object's aside name, which spells its object's name before its digest, among
 *   them. A drawn role's aside name is the naming door's own for a drawn stem (identity.roleAside), a drawn object's its
 *   own for a drawn name (identity.aside), and a drawn live source's name its own for a drawn root
 *   (identity.liveSource).
 *
 * Features: a prefix and none, a capitalized schema spelling, an unknown variable, a stem variable, an aside variable,
 * a live source variable.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	draftCase,
	type DraftFeature,
	draftingSpace
} from "#test/unit/deploy/variables.fixtures.ts"

/** The variables of a drafted migration fill every drafted statement under each drawn role space as psql interpolates it, byte for byte under none, name every created role by its variable, and refuse every variable that is neither DBNAME nor a role's stem, aside or live source name. Its budget is its suite's before it was a property (test/unit/deploy/variables.test.ts at 4ca3036a): 24 runs and 16 steered cases. */
export const theVariablesOfADraftedMigrationFillEveryDraftedStatementUnderEachDrawnRoleSpaceAsPsqlInterpolatesItByteForByteUnderNoneNameEveryCreatedRoleByItsVariableAndRefuseEveryVariableThatIsNeitherDBNAMENorARolesStemAsideOrLiveSourceName =
	property.explore(draftingSpace, {
		needs: {},
		budget: { runs: 24, steered: 16 },
		situations: [
			"a prefix",
			"no prefix",
			"a capitalized schema spelling",
			"an unknown variable",
			"a stem variable",
			"an aside variable",
			"a live source variable"
		] satisfies ReadonlyArray<Reached<DraftFeature>>,
		check: (_, c: Case<DraftFeature>) => (value) => draftCase(value, c),
		oracle: {
			kind: "specification",
			name: "psql's identifier interpolation, each variable its role under the space"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\t\t\`CREATE ROLE \${printRole(statement.name)} \${statement.login ? "LOGIN NOINHERIT" : "NOLOGIN"}\``,
				replacement: `\t\t\t\t\`CREATE ROLE \${quoteIdent(statement.name)} \${statement.login ? "LOGIN NOINHERIT" : "NOLOGIN"}\``,
				why: "A CREATE ROLE prints its role by its quoted stem, no variable; the property that every created role is a variable fails."
			},
			{
				file: "packages/engine/src/deploy/render/variables.ts",
				original: "\t\tResult.map(roleInSpace(names.roles, variable.name), quote),",
				replacement:
					"\t\tResult.map(Result.flatMap(roleInSpace(names.roles, variable.name), (once) => roleInSpace(names.roles, once)), quote),",
				why: "A role variable is filled with the prefix twice; the prefix property fails."
			},
			{
				file: "packages/engine/src/deploy/render/variables.ts",
				original: '\t\treturn { kind: "database" }',
				replacement: '\t\treturn { kind: "role", name, form: "stem" }',
				why: "The database variable is filled as a role's name, DBNAME's in the role space, not the database's; the property that the variables are DBNAME and a role's names fails."
			}
		]
	})
