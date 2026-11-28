/**
 * The fresh installation as a whole (physical/install/compile.ts), over generated schemas, extended types and span keys
 * included, with the one login whose full role writes every relation (`oracleLogin`):
 *
 * - **Install order:** the manifest is the install order: phases in order, every edge from an earlier object to a later
 *   one, and each object kind after the kinds PostgreSQL needs before it, as the model of object kinds states them (the
 *   namespace before what it holds, types before tables, tables before what refers to or is built on them, a role
 *   before its memberships, its policies and its privileges, a schema of views before its views); every
 *   object needed and justified, and every constraint or index justified by a law or a program, but for the CHECKs
 *   that enforce a span or vector column's own type. The model is total over src's PhysicalKind by the union itself, so
 *   a new kind is a compile error here until its place is stated.
 * - **No function, nothing of one:** a schema that declares no function (fn) installs no function owner, row type or
 *   declared function, so what it drafts is what it drafted before a level could declare one.
 * - **Declaration order (metamorphic):** the SQL is byte for byte the same whatever order the relations and statements
 *   are declared in.
 * - **Identifiers:** the installed schema is the conversion of the schema's declared name, and a declared name the rule
 *   refuses (its own, or a conversion PostgreSQL reserves with pg_) is refused at its declaration, IdentifierTooLong for
 *   a conversion past 63 bytes and MalformedDescription for any other; only an admitted
 *   identifier (plain lowercase, at most 63 bytes, outside pg_, drawn up to that bound) names the vector schema or the
 *   extension schema, which lies outside the installed one; no schema the installation creates takes a
 *   schema it names, and its relations lie in the installed schema.
 *
 * What the installed catalog holds is PostgreSQL's to judge, in the database suites.
 *
 * Oracles: the model of object kinds (kindModel); the declared order's installation, against the permuted one's; the
 * naming door's rule of a declared name and of an identifier, restated, each broken name built by the rule it breaks.
 *
 * Features: a foreign key, a constant, a domain, a law index and a type CHECK; relations and statements reordered; each
 * broken rule refused at each slot, an extension schema that is the schema, and each spelling installed.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { shuffled } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { DeployPhase, PhysicalKind } from "#compiler/ir/products.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { phaseOrder } from "#compiler/physical/obligations/graph.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import * as work from "#test/support/fixtures/ir/work.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import {
	admitted,
	type DeclaredFault,
	generatedGen,
	type IdentifierFault,
	installed,
	kindModel,
	loginOver,
	namesGen,
	type OrderFeature,
	type Slot,
	spell,
	type Spelling,
	typeChecks
} from "#test/support/unit/physical/install.fixtures.ts"

/** The fresh installation is in install order, every object needed and justified, every edge kept. Its budget is its suite's before it was a property (test/unit/physical/install.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const theFreshInstallationIsInInstallOrderEveryObjectNeededAndJustifiedEveryEdgeKept =
	property.explore(generatedGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"a foreign key",
			"a constant",
			"a domain",
			"a law index",
			"a type CHECK"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, c: Case<OrderFeature>) => (desc) =>
			Effect.sync(() => {
				const i = installed(desc)
				const checks = typeChecks(i)
				const objects = i.manifest.objects
				const rank = (p: DeployPhase) => phaseOrder.indexOf(p)
				for (const [k, current] of objects.entries()) {
					if (k > 0) {
						assert.ok(rank(current.phase) >= rank(defined(objects[k - 1]).phase), current.ident)
					}
				}
				const position = new Map(Arr.map(objects, (o, k) => [o.ident, k]))
				for (const e of i.manifest.edges) {
					assert.ok(
						defined(position.get(e.from)) < defined(position.get(e.to)),
						`${e.from} before ${e.to}`
					)
				}
				const creates = (kind: PhysicalKind) => Arr.some(objects, (o) => o.kind === kind)
				const lastOf = (kind: PhysicalKind) => Arr.map(objects, (o) => o.kind).lastIndexOf(kind)
				assert.ok(creates("schema"), "the installation creates its namespace")
				assert.deepEqual(
					Arr.filter(
						objects,
						(o) =>
							o.kind === "functionOwner" || o.kind === "rowType" || o.kind === "declaredFunction"
					),
					[],
					"a schema that declares no function installs no function owner, row type or declared function"
				)
				for (const [k, o] of objects.entries()) {
					for (const before of kindModel[o.kind].after) {
						assert.ok(lastOf(before) < k, `every ${before} before ${o.ident}`)
					}
				}
				if (creates("foreignKey")) {
					c.note("a foreign key")
				}
				if (creates("constant")) {
					c.note("a constant")
				}
				if (creates("domain")) {
					c.note("a domain")
				}
				for (const o of objects) {
					assert.equal(o.state, "needed")
					assert.ok(o.reasons.length > 0, o.ident)
					if (o.kind === "index" && Arr.some(o.reasons, (r) => r.kind === "law")) {
						c.note("a law index")
					}
					const lawful = Arr.some(o.reasons, (r) => r.kind === "law" || r.kind === "access")
					const typeCheck =
						checks.has(o.ident) && Arr.every(o.reasons, (r) => r.kind === "enforcement")
					switch (kindModel[o.kind].justified) {
						case "any reason":
							break
						case "a law or a program":
							assert.ok(lawful, o.ident)
							break
						case "a law, a program or its column's type":
							if (typeCheck) {
								c.note("a type CHECK")
							}
							assert.ok(lawful || typeCheck, o.ident)
							break
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the model of object kinds: what precedes each, and what justifies it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/obligations/graph.ts",
				original: '\t"structure",\n\t"indexes",',
				replacement: '\t"indexes",\n\t"structure",',
				why: "The Indexes phase is ordered before Structure, its tables'."
			},
			{
				file: "packages/engine/src/physical/ddl/functions.ts",
				original: "\tif (first === undefined) {\n\t\treturn out\n\t}\n",
				replacement: "",
				why: "An installation that declares no function holds the function owner, a role and its grants no function needs, so a schema without fn drafts what it did not."
			}
		]
	})

/** The fresh installation compiles byte-identical SQL whatever order the relations and statements are declared in. Its budget is its suite's before it was a property (test/unit/physical/install.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const theFreshInstallationCompilesByteIdenticalSQLWhateverOrderTheRelationsAndStatementsAreDeclaredIn =
	property.explore(
		(source) => {
			const desc = source.draw(generatedGen)
			const all = (n: number) => ({ min: n, max: n })
			return {
				desc,
				relations: source.draw(shuffled(desc.relations, all(desc.relations.length))),
				statements: source.draw(shuffled(desc.statements, all(desc.statements.length)))
			}
		},
		{
			needs: {},
			budget: { runs: 60, steered: 60 },
			situations: ["relations reordered", "statements reordered"] satisfies ReadonlyArray<
				Reached<"relations reordered" | "statements reordered">
			>,
			check:
				(_, c: Case<"relations reordered" | "statements reordered">) =>
				({ desc, relations, statements }) =>
					Effect.sync(() => {
						if (Arr.some(relations, (r, k) => r !== desc.relations[k])) {
							c.note("relations reordered")
						}
						if (Arr.some(statements, (s, k) => s !== desc.statements[k])) {
							c.note("statements reordered")
						}
						const declared = installed(desc).statements
						assert.deepEqual(installed({ ...desc, relations, statements }).statements, declared)
					}),
			oracle: {
				kind: "universal",
				name: "an installation is invariant under its declaration's order"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/laws/model/model.ts",
					original: "next.getOrInsertComputed(b, () => [])",
					replacement: "{}",
					why: "Operator mutant 486fb72f4f at packages/engine/src/laws/model/model.ts:611 in fkCyclesOf: `next.set(b, [])` becomes `{}`; the property fails (the census, lane TESTPOLICY2). Restated over its getOrInsertComputed spelling (lane UNIFY7)."
				}
			]
		}
	)

/** The fresh installation names its schema, vector schema and extension schema by admitted identifiers only. Its budget is its suite's before it was a property (test/unit/physical/install.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const theFreshInstallationNamesItsSchemaVectorSchemaAndExtensionSchemaByAdmittedIdentifiersOnly =
	property.explore(namesGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a leading underscore refused",
			"a leading digit refused",
			"an outside character refused",
			"a conversion past 63 bytes refused",
			"the empty name refused",
			"a pg_ conversion refused",
			"uppercase refused",
			"leading digit refused",
			"pg_ prefix refused",
			"outside character refused",
			"64 bytes refused",
			"empty refused",
			"schema refused",
			"vector schema refused",
			"extension schema refused",
			"an extension schema that is the schema",
			"snake installed",
			"camel installed",
			"Pascal installed",
			"a trailing underscore installed"
		] satisfies ReadonlyArray<
			Reached<
				| `${DeclaredFault} refused`
				| `${IdentifierFault} refused`
				| "schema refused"
				| `${Slot} refused`
				| "an extension schema that is the schema"
				| `${Spelling} installed`
			>
		>,
		check:
			(
				_,
				c: Case<
					| `${DeclaredFault} refused`
					| `${IdentifierFault} refused`
					| "schema refused"
					| `${Slot} refused`
					| "an extension schema that is the schema"
					| `${Spelling} installed`
				>
			) =>
			(n) =>
				Effect.sync(() => {
					if (n.broken.kind === "schema") {
						c.note(`${n.broken.name.rule} refused`)
						c.note("schema refused")
						refused(
							ownedInput({ ...work.WorkDesc, name: n.broken.name.name }),
							n.broken.name.rule === "a conversion past 63 bytes"
								? "IdentifierTooLong"
								: "MalformedDescription"
						)
						return
					}
					const owned = owning({
						...work.WorkDesc,
						name: spell(n.schema.words, n.schema.spelling)
					})
					const schema = Arr.join(n.schema.words, "_")
					const at = (slot: Slot, name: string) =>
						n.broken.kind === "identifier" && n.broken.slot === slot ? n.broken.name.name : name
					const extensionSchema = at(
						"extension schema",
						n.extensionIsSchema ? schema : n.extensionSchema
					)
					const vectorSchema = at("vector schema", n.vectorSchema)
					const login = loginOver(owned.desc)
					const result = compileInstallation(owned, {
						...installOptions(owned),
						vectorSchema,
						extensionSchema,
						logins: [login]
					})
					const named = [vectorSchema, extensionSchema]
					if (!Arr.every(named, admitted)) {
						if (n.broken.kind === "identifier") {
							c.note(`${n.broken.name.rule} refused`)
							c.note(`${n.broken.slot} refused`)
						}
						refused(result, "MalformedDescription")
						return
					}
					if (extensionSchema === schema) {
						c.note("an extension schema that is the schema")
						refused(result, "MalformedDescription")
						return
					}
					c.note(`${n.schema.spelling} installed`)
					const i = succeeded(result)
					assert.deepEqual(
						Arr.map(i.worlds, (w) => ({
							name: w.name,
							roles: Arr.map(w.roles, (r) => r.name)
						})),
						[{ name: login.name, roles: Arr.map(login.roles, (r) => r.name) }]
					)
					for (const created of i.statements) {
						if (created.kind === "createSchema" && created.name !== schema) {
							assert.ok(!named.includes(created.name), created.name)
						}
					}
					for (const r of work.WorkDesc.relations) {
						assert.equal(i.names.relation(r.name).schema, schema)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the naming door's rule of a declared name and of an admitted identifier"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/install/compile.ts",
				original:
					'\tif (name.length === 0 || name.length > maxIdentifierBytes || name.startsWith("pg_")) {',
				replacement:
					'\tif (name.length === 0 || name.length > maxIdentifierBytes + 1 || name.startsWith("pg_")) {',
				why: "An identifier of 64 bytes is admitted for the vector schema and the extension schema."
			}
		]
	})
