/**
 * grizzle's library in an installation (physical/ddl/library.ts): a library function is installed exactly where a
 * persistent expression of the schema calls it, before every object that calls it, and every role may call it.
 *
 * The property: over a schema whose relation Links resolves an href against a base (Text.resolveReference) in a
 * generated field, a row check or its href's contract, or nowhere, and a login of a role that writes Links and a role
 * that reads it alone, the installation creates the library function, by the name its definition's digest gives it,
 * exactly where the schema calls it; it revokes it from PUBLIC and grants each role EXECUTE on it by its two text
 * parameters; it creates it before every statement that calls it, and every object whose statements call it waits for
 * it in the manifest, so a migration creates the function before them and drops them before it; and the installation's
 * names name it where it is installed and refuse it as UninstalledFunction where it is not.
 *
 * Oracle: the installation's own statements and manifest, read for the function's name.
 *
 * Features: each place the schema calls it, and none.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { libraryIdentity } from "#compiler/physical/ddl/library.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { contract } from "#compiler/public/fields.ts"
import { check, login, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { loginDescOf, roleBuilder as role } from "#compiler/schema/world.ts"
import type { FunctionName, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { Id } from "#test/support/ids.ts"
import { owning } from "#test/support/policy.ts"

/** Where the schema calls Text.resolveReference. */
type Use = "a generated field" | "a row check" | "a contract's predicate" | "nowhere"

const uses: Arr.NonEmptyReadonlyArray<Use> = [
	"a generated field",
	"a row check",
	"a contract's predicate",
	"nowhere"
]

const text = str.regex("^.*$", "su")

/** An href no fragment ends: its target against the empty reference is itself. */
const Unfragmented = contract(
	"Unfragmented",
	text,
	(v) => Logic.eq(Text.resolveReference(v, ""), v),
	undefined
)

/** The schema, its Links relation calling Text.resolveReference at `use`, and a login of a writer and a reader. */
const built = (use: Use) => {
	const fields = {
		id: Id,
		base: text,
		href: use === "a contract's predicate" ? Unfragmented : text
	}
	const Links =
		use === "a generated field"
			? relation.generated("Links", fields, ["id"], (r) => ({
					target: generatedField(text, Text.resolveReference(r.base, r.href), [])
				}))
			: relation("Links", fields, ["id"])
	const statements =
		use === "a row check"
			? [check("Resolved", Links, (r) => Logic.ne(Text.resolveReference(r.base, r.href), r.base))]
			: []
	const s = schema("Library", [Links], statements)
	return login(s, "desk", [
		role(s, "writer", { Links }, { insert: ["Links"] }),
		role(s, "reader", { Links }, { write: [] })
	])
}

/** The two text parameters a GRANT and a REVOKE name the library function by. */
const textArgs: ReadonlyArray<TypeRef> = [types.text, types.text]

const namesFunction = (n: FunctionName, schema: string, name: string): boolean =>
	n.schema === schema &&
	n.name === name &&
	printStatement({ kind: "dropFunction", name: n, ifExists: false }) ===
		printStatement({
			kind: "dropFunction",
			name: { schema, name, args: textArgs },
			ifExists: false
		})

/** A library function is installed exactly where a persistent expression calls it, before its callers, and every role may call it. */
export const aLibraryFunctionIsInstalledExactlyWhereAPersistentExpressionCallsItBeforeItsCallersAndEveryRoleMayCallIt =
	property.exhaust(
		finite((source) => source.draw(element(uses))),
		{
			box: "each place the schema calls it, and none",
			needs: {},
			situations: uses satisfies ReadonlyArray<Reached<Use>>,
			check: (_, c: Case<Use>) => (use) =>
				Effect.sync(() => {
					c.note(use)
					const desk = built(use)
					const owned = owning(desk.base)
					const own = ownLogin(defined(loginDescOf(desk), "a login built by login(...)"))
					const compiled = compileInstallation(
						owned,
						completeInstallOptions(
							owned,
							installationsOf(owned),
							[own.ok ? own.value : assert.fail(own.error.message)],
							[],
							firstCodebook(rostersOf(owned))
						)
					)
					const i = compiled.ok ? compiled.value : assert.fail(compiled.error.message)
					const name = identifierOf(libraryIdentity("resolveReference"))
					const schemaName = i.names.schema
					const creates = (s: SqlStatement): boolean =>
						s.kind === "createConstant" && s.name.name === name
					const named = catchRefusal(() => i.names.library("resolveReference"))
					if (use === "nowhere") {
						assert.ok(!Arr.some(i.statements, creates), "no call installs no library function")
						assert.ok(
							!named.ok && named.error.reason._tag === "UninstalledFunction",
							"the names refuse an uninstalled library function"
						)
						return
					}
					assert.equal(
						Arr.length(Arr.filter(i.statements, creates)),
						1,
						`a call in ${use} installs it once`
					)
					assert.deepEqual(
						named.ok ? named.value : assert.fail(named.error.message),
						{ kind: "qualified", schema: schemaName, name, volatility: "IMMUTABLE" },
						"the names name the installed function"
					)
					assert.ok(
						Arr.some(
							i.statements,
							(s) =>
								s.kind === "revoke" &&
								s.on.kind === "FUNCTION" &&
								Arr.some(s.on.names, (n) => namesFunction(n, schemaName, name)) &&
								Arr.some(s.from, (g) => g.kind === "PUBLIC")
						),
						"revoked from PUBLIC by its parameters"
					)
					for (const r of Arr.flatMap(i.worlds, (l) => l.roles)) {
						assert.ok(
							Arr.some(
								i.statements,
								(s) =>
									s.kind === "grant" &&
									s.on.kind === "FUNCTION" &&
									Arr.some(s.privileges, (p) => p === "EXECUTE") &&
									Arr.some(s.on.names, (n) => namesFunction(n, schemaName, name)) &&
									Arr.some(s.to, (g) => g.kind === "role" && g.name === r.role)
							),
							`${r.name} is granted EXECUTE on it by its parameters`
						)
					}
					const quoted = `"${name}"`
					const calls = (s: SqlStatement): boolean =>
						s.kind !== "createConstant" &&
						s.kind !== "revoke" &&
						s.kind !== "grant" &&
						s.kind !== "comment" &&
						Str.includes(quoted)(printStatement(s))
					const created = Option.getOrThrow(Arr.findFirstIndex(i.statements, creates))
					Arr.forEach(i.statements, (s, at) => {
						if (calls(s)) {
							assert.ok(created < at, `created before ${printStatement(s)}`)
						}
					})
					const objects = i.manifest.objects
					const fn = Option.getOrThrow(Arr.findFirst(objects, (o) => Arr.some(o.ddl, creates)))
					const callers = Arr.filter(objects, (o) => Arr.some(o.ddl, calls))
					assert.ok(Arr.isArrayNonEmpty(callers), "an object calls it")
					for (const o of callers) {
						assert.ok(
							Arr.some(i.manifest.edges, (e) => e.from === fn.ident && e.to === o.ident),
							`${o.ident} waits for the library function`
						)
					}
				}),
			oracle: {
				kind: "specification",
				name: "the installation's statements and manifest, read for the function's name"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/physical/ddl/library.ts",
					original: "\treturn [...called].toSorted(compareStrings)",
					replacement: "\treturn []",
					why: "No schema installs the library function, so every call of it is refused as UninstalledFunction."
				},
				{
					file: "packages/engine/src/physical/ddl/roles.ts",
					original: "\t\t\t...b.library.map((fn) => b.names.library(fn).name)",
					replacement: "",
					why: "A role that only reads Links is granted no EXECUTE on the function its queries may call."
				},
				{
					file: "packages/engine/src/physical/ddl/context.ts",
					original: "\t\t\treturn s.params.map((p) => p.type)",
					replacement: "\t\t\treturn []",
					why: "A grant names the function of no parameter, which is not the library function."
				},
				{
					file: "packages/engine/src/physical/obligations/graph.ts",
					original: '\t\t\t\tnamed("function", f.schema, f.name)\n',
					replacement: "",
					why: "A contract's domain that calls the function does not wait for it, so a migration may drop the function before it."
				}
			]
		}
	)
