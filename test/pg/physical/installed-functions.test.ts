/**
 * Every function an installation creates of a kind the installer names a constant by (physical/ddl/context.ts
 * addConstant) passes the installed-catalog checker on PostgreSQL 19 (test/support/catalog/installed.ts
 * checkInstallation, which every migrated install runs), judged by the kind the installer recorded it as
 * (Installation identities), never by its language or its shape: a closed relation's constant and a roster's an SQL
 * function of no argument and no SET clause; a row function and a library function the shape its CREATE states, its
 * language, its parameters in order, STRICT exactly where stated and its SET clauses (test/support/catalog/verify.ts
 * StatedShape); each with EXECUTE held by exactly the roles whose reads and writes call it. And the migrator's drift
 * check replays every constant as its stub (sql/ast.ts StubConstant), which PostgreSQL runs where it evaluates a row
 * function of no parameter as it creates its table.
 *
 * - **Property:** over the row-function boxes (test/support/unit/physical/row-functions.fixtures.ts), boxes calling each
 *   library function a schema reaches, Text.resolveReference and Crypto.sha256 in a generated field, Xml.isPattern in a
 *   CHECK, and a key over a generated Crypto.sha256 of a text of no byte bound, and a box whose generated set field reads no
 *   column, a closed relation's closed id at a handle it holds a row of or none (installed-functions.fixtures.ts),
 *   each installed by the migrator in a database of its own, whose install runs the structural audit, which holds every
 *   alias of every statement, a library body's among them, to the name supply's, the drift check, which builds the
 *   snapshot's replay beside it, and the checker, the catalog holds every function the installation's constant objects
 *   create.
 * - **Oracle:** specification: the checker's rule for each kind, by the kind the installer recorded; and PostgreSQL,
 *   which builds the replay.
 * - **Features:** an installation creating a function of each kind, and a row function of no parameter.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	functionCaseGen,
	functionSchemaOf
} from "#test/pg/physical/installed-functions.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { installGenerated } from "#test/support/install-migrate.ts"
import { ownerSession, Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

type KindFeature =
	| "a closed relation's constant"
	| "a roster's constant"
	| "a row function"
	| "a library function"
	| "a row function of no parameter"

/** The feature each kind the installer records a constant's function as reaches. */
const featureOf: Readonly<Record<string, KindFeature>> = {
	closedConstant: "a closed relation's constant",
	rosterConstant: "a roster's constant",
	rosterLive: "a roster's constant",
	rowFunction: "a row function",
	libraryFunction: "a library function"
}

/** The functions of an installation's schema the catalog holds, by name. */
const functionsSql =
	"SELECT p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1"

/** Every function an installation emits, of every kind the installer names a constant by, passes the installed-catalog checker, judged by the kind the installer recorded. */
export const everyFunctionAnInstallationEmitsOfEveryConstantKindPassesTheInstalledCatalogChecker =
	property.explore(functionCaseGen, {
		needs: { substrate2: Substrate.fresh(baseSubstrate) },
		budget: { runs: 16, steered: 16 },
		situations: [
			"a closed relation's constant",
			"a roster's constant",
			"a row function",
			"a library function",
			"a row function of no parameter"
		] satisfies ReadonlyArray<Reached<KindFeature>>,
		check:
			({ substrate2 }, c: Case<KindFeature>) =>
			(functionCase) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const owner = yield* substrate.session({ ...ownerSession(), label: "functions owner" })
						return yield* Effect.scoped(
							Effect.gen(function* () {
								const { installed } = yield* installGenerated(
									(name) => functionSchemaOf(functionCase, name),
									{ label: "functions", ambient: ordinarySession }
								)
								const i = installed.installation
								const created = Arr.flatMap(i.manifest.objects, (o) =>
									o.kind === "constant"
										? Arr.flatMap(o.ddl, (s) =>
												s.kind === "createConstant"
													? [s.name.name]
													: s.kind === "packConstant"
														? [s.function.name]
														: []
											)
										: []
								)
								const rows = yield* owner.values(functionsSql, [i.names.schema])
								const held = new Set(Arr.map(rows, (row) => String(row[0])))
								assert.deepEqual(
									Arr.sort(
										Arr.filter(created, (name) => !held.has(name)),
										Order.String
									),
									[],
									"the catalog holds every function the installation's constants create, each passing the checker"
								)
								const named = new Set(created)
								for (const n of i.identities) {
									const feature = featureOf[n.kind]
									if (feature !== undefined && named.has(n.identifier)) {
										c.note(feature)
									}
								}
								if (
									Arr.some(
										i.statements,
										(s) =>
											s.kind === "createConstant" &&
											s.language === "plpgsql" &&
											s.params.length === 0
									)
								) {
									c.note("a row function of no parameter")
								}
							})
						)
					}),
					Substrate,
					Effect.map(substrate2, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the installed-catalog checker's rule for each kind of constant function, by the kind the installer recorded (test/support/catalog/verify.ts)"
		},
		kept: [],
		kills: [
			{
				file: "test/support/catalog/installed.ts",
				original:
					"\t\t\tisConstantKind(named.kind) ? [[named.identifier, named.kind] as const] : []\n",
				replacement:
					'\t\t\tisConstantKind(named.kind) ? [[named.identifier, named.kind === "libraryFunction" ? "closedConstant" : named.kind] as const] : []\n',
				why: "A library function is judged as a closed relation's constant, an SQL function of no argument, so the checker refuses every key over a text of no byte bound and every call of Text, Crypto or Xml in a persistent expression, as FILLORDER's installs met."
			},
			{
				file: "test/support/catalog/installed.ts",
				original:
					"\t\t\tisConstantKind(named.kind) ? [[named.identifier, named.kind] as const] : []\n",
				replacement:
					'\t\t\tisConstantKind(named.kind) ? [[named.identifier, named.kind === "rowFunction" ? "closedConstant" : named.kind] as const] : []\n',
				why: "A row function is judged as a closed relation's constant, so the checker refuses every PL/pgSQL row function of the columns it reads under its closed search_path, as level-checks met at 56f26ca01."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: "\tconst alias = names.relation(internal(what))\n",
				replacement: '\tconst alias = names.relation(internal(what)).replace("r", "s")\n',
				why: "A library body names its relations by hand, as resolveReference's s1 to s7 and isXsdPattern's t and r were, which the structural audit refuses and a caller's names could meet: every install of a schema calling them dies at the audit."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `const stubValue = (returns: TypeRef): string => \`NULL::\${printType(returns)}\`\n`,
				replacement: `const stubValue = (returns: TypeRef): string => \`X''::\${printType(returns)}\`\n`,
				why: "The drift check replays every constant as an empty bit string, which PostgreSQL refuses for a library function of a boolean result, isXsdPattern's (42846, cannot cast type bit to boolean), so every migration of a schema calling Xml.isPattern stops at its check."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `const stubValue = (returns: TypeRef): string => \`NULL::\${printType(returns)}\`\n`,
				replacement: `const stubValue = (returns: TypeRef): string => \`\${returns.array ? "'{}'" : returns.kind === "builtin" && (returns.name === "text" || returns.name === "bytea") ? "''" : returns.kind === "builtin" && returns.name === "boolean" ? "false" : "X''"}::\${printType(returns)}\`\n`,
				why: "The drift check replays a constant as the empty value of its type, a bit string's X'', where a row function of no parameter, a generated set field reading no column, is evaluated by PostgreSQL as the replay creates its table: the row function's bits, padded to its domain's width, meet the live constant's empty ones in the domain's CHECK (22026, cannot AND bit strings of different sizes), so every migration of such a schema stops at its drift check, as null/positions met at 56f26ca01."
			}
		]
	})
