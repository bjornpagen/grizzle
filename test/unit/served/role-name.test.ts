/**
 * The one roleNameOf: a login's, a role's, a served login's and its decoder login's PostgreSQL role under an
 * installation's role space, with no database.
 *
 * A case draws a schema's declared name (its letter segments lowercase, capitalized or in capitals, or a name in the
 * test substrate's allocation grammar, `gz_<label>_<pid>_<n>_<ten digits>`, perhaps padded to a drawn length, as the
 * network suites' installations are named), a login and one or
 * two roles over one relation (names of lowercase words or camel case, every conversion apart), whether the login's
 * workload holds a read of the relation, and two role spaces: each none or a role prefix (lowercase words and digit
 * runs joined by single underscores, as `qti_pie_v2` is written), the two apart. The login is compiled as `grizzle
 * generate` compiles it (test/support/served-login.ts compiledLogin) and its file served as an application serves it
 * (adapter/served/served.ts served).
 *
 * Properties, each against its oracle:
 * - Default oracle: under no prefix, roleNameOf of the login and of each role is the naming door's identity of it
 *   (core/identity.ts identity.login, identity.role, under identity.schema of the parsed schema name), and under a
 *   prefix p, `<p>__<that identity>`, the prefix verbatim: the specification of a role space, spelled here apart from
 *   the function under test.
 * - Decoder: the served login names a decoder login (ServedLogin decoder) exactly when its workload reads, as the case
 *   built it, and roleNameOf of it is the naming door's identity of the installation's live source
 *   (identity.liveSource of the schema's identifier) under the space, by the same specification.
 * - One function: connectionOf, a connection builder that takes an authoring login, a served login or a decoder login,
 *   names each by the one roleNameOf, and the authoring and the served login name the same role; each served role's
 *   stem under the space is roleNameOf of its authoring role, the role a served layer takes on.
 * - Disjoint: the two spaces' roles share no name, the decoder's among them.
 * - Bound: a prefix is at most the budget the longest hashed role name leaves, 63 - 2 - |__aside_<digest>| = 43 bytes,
 *   and one past it is refused where it is parsed (MalformedDescription); within it, a prefix whose longest role passes
 *   63 bytes is refused (IdentifierTooLong), and one that fills 63 exactly is not.
 * - The decoder fits: under a prefix at the budget, the longest any installation admits, the decoder login's role is
 *   named, whatever the schema's name, an allocation's included, and so is every role set aside while logins are
 *   renamed (identity.roleAside of the login's and each role's stem, as migrate fills it, core/identity.ts roleInSpace):
 *   so every prefix that fits the ordinary roles fits them too.
 *
 * Features: a prefix and none, two prefixes, a capitalized spelling, a camel-case name, a prefix at the limit and one
 * byte past, a prefix past the budget, a login that reads and one that reads nothing, an allocator's schema name, a
 * decoder under a prefix at the budget.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { nameCase, type NameFeature, namesGen } from "#test/unit/served/role-name.fixtures.ts"

/**
 * The one roleNameOf names a login's, its roles', its served file's and its decoder login's PostgreSQL roles as the
 * naming door's stems under each drawn role space, through one function, the spaces disjoint and the 63-byte bound
 * held.
 *
 * Budget: its suite's count before the conversion (unit/served/role-name: 64 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theOneRoleNameOfNamesALoginsItsRolesItsServedFilesAndItsDecoderLoginsPostgreSQLRolesAsTheNamingDoorsStemsUnderEachDrawnRoleSpaceThroughOneFunctionTheSpacesDisjointAndThe63ByteBoundHeld =
	property.explore(namesGen, {
		needs: {},
		situations: [
			"a prefix and none",
			"two prefixes",
			"a capitalized spelling",
			"a camel-case name",
			"a prefix at the limit",
			"a prefix one byte past",
			"a prefix past the budget",
			"a login that reads",
			"a login that reads nothing",
			"an allocator's schema name",
			"a decoder under a prefix at the budget"
		] satisfies ReadonlyArray<Reached<NameFeature>>,
		check: (_, c: Case<NameFeature>) => (value) => nameCase(value, c),
		oracle: {
			kind: "specification",
			name: "a role space: the naming door's stem, under `<prefix conversion>__` when prefixed"
		},
		budget: { runs: 64, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/stem.ts",
				original:
					"\t\t\tcatchCompileError(() => identifierOf(loginIdentity(installation, name, login.loc)))",
				replacement: `\t\t\tcatchCompileError(() => \`\${login.base.name}__\${login.name}\`)`,
				why: "login(...) computes its stem from the declared names as written, not their conversions (schema/stem.ts loginStem); the default oracle fails."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: `\tconst role = \`\${space.prefix}\${roleSeparator}\${name}\``,
				replacement: `\tconst role = \`\${conversionOf(space.prefix)}\${roleSeparator}\${name}\``,
				why: "roleInSpace converts the prefix as a declared name, `qti_pie_v2` installing as `qti_pie_v_2`; the default oracle fails."
			},
			{
				file: "packages/grizzle/src/adapter/served/served.ts",
				original: "): string => {",
				replacement:
					'): string => {\n\tif (named.kind === "decoderLogin") {\n\t\treturn named.stem\n\t}',
				why: "roleNameOf names a decoder login by its stem whatever the prefix; the decoder property fails."
			},
			{
				file: "packages/grizzle/src/adapter/served/served.ts",
				original:
					'\t\t\treturn Object.freeze({ ...builtMark, kind: "decoderLogin", login, stem: live.stem })',
				replacement: "\t\t\treturn noDecoder",
				why: "served names no decoder for a login that reads; the decoder property fails."
			},
			{
				file: "packages/grizzle/src/adapter/served/served.ts",
				original: "\t\tdecoder: decoderOf<L>(name, read.live),",
				replacement:
					'\t\tdecoder: decoderOf<L>(name, read.live.kind === "source" ? { ...read.live, stem: read.role } : read.live),',
				why: "A decoder login carries its served login's stem, not the live source's; the decoder property fails."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: `\t\tmint("liveSource", [root], [liveSegment], \`live source of \${root}\`, hashed),`,
				replacement: `\t\tmint("liveSource", [root], [liveSegment, ...nameSegments(root)], \`live source of \${root}\`, hashed),`,
				why: "The live source's stem carries the root's segments again; the decoder-fits property fails."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original: `\t\tmint("roleAside", [role], [asideSegment], \`the role \${role} set aside\`, hashed),`,
				replacement: `\t\tmint("roleAside", [role], [asideSegment, ...nameSegments(role)], \`the role \${role} set aside\`, hashed),`,
				why: "A role's aside name carries its stem's segments again; the decoder-fits property fails for the roles set aside."
			}
		]
	})
