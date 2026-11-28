/**
 * Declared functions as schema objects, on PostgreSQL 19: a schema that declares functions migrates, drifts and grants
 * as its snapshot says, through a second version that changes them, and its functions read no table.
 *
 * - **Property:** a case draws a first version of one to three functions over one to three headings, each heading's
 *   field a value, rows of a heading before it or one row of one, each argument and result a value of a drawn type,
 *   rows of a heading or one row of it, each body PL/pgSQL or SQL spelled with
 *   spaces, tabs, a dollar-quote tag inside it or a trailing dollar sign (test/support/declared-functions.ts), some
 *   calling the helper, a declared function, by its unqualified name, and some calling drawn functions declared before
 *   them, each argument of one row a row of NULLs cast to its row type by the name `fn.body` gives it, of rows an array
 *   of one such row, a field of a row or of rows built alike, some
 *   naming besides the row types of their own signature's or a callee's headings, a PL/pgSQL body in a variable it
 *   declares, an SQL one in a cast; beside the helper, declared before or after its callers, and `peek`, a PL/pgSQL
 *   function that counts N's rows; declared at the root or at an extension over it. Its second version changes a body,
 *   a volatility, a null input (called on NULL input or strict), a signature or a heading, removes or adds a function,
 *   or removes every one. Both migrate through the
 *   real runner, whose drift check admits each. Then: every declared function's source as PostgreSQL stores it digests
 *   to its declared body's SHA-256, each heading it names the name of the row type PostgreSQL holds of the heading's
 *   attributes; the second version's migration drops and creates again exactly the functions whose signature it
 *   changes, replaces in place exactly the ones whose definition alone it changes (a body naming a changed heading
 *   among them), creates the added and drops the removed, and touches no other; every one is owned by the
 *   installation's function owner, and PUBLIC executes none; the function owner holds no privilege on any relation of
 *   the installation; each function and the helper, called with NULLs, answers, a strict one without running its body,
 *   a called one running it and every call it makes;
 *   `peek` is refused, 42501, since its owner reads no table; and the migrated catalog is a fresh installation's of the
 *   second version. A case then plants by hand a body created again under its header, the helper made STRICT, SELECT
 *   on N granted to the function owner, or an attribute added to a row type, and the drift check refuses the database
 *   naming it.
 * - **Oracle:** PostgreSQL: its acceptance of each folder, its SHA-256 of each source, its row types' attributes, its
 *   privileges, the calls it runs and refuses, its catalog against a fresh installation's, and the drift check's
 *   reading of each plant; and the model of what each function is to PostgreSQL, its signature and its definition, each
 *   heading by its content, whose change between the versions is each function's fate, against the reviewed DDL.
 * - **Features:** each change, plant and fate, each body spelling and language, each volatility and null input, a body of each
 *   language naming a row type, one naming a callee's alone and one naming a changed heading it takes no rows of,
 *   arguments and results of rows and of one row, a heading's field of rows and of one row, a helper call, a call of a
 *   drawn function with a composite and one passing a nested composite, an SQL caller declared before its callee,
 *   functions at an extension, a row type two functions share, and the refused table read.
 */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { mismatchLine } from "#adapter/admission/drift.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import {
	callOf,
	callsOf,
	functionCaseSpace,
	declaredBodies,
	declaredNames,
	declaredSignatures,
	fatesIn,
	fatesOf,
	features,
	type FunctionFeature,
	heldBodies,
	installedFunctions,
	installedSignatures,
	ownerTablePrivileges,
	peekCall,
	plantOf,
	publicFunctions,
	reached,
	rowText,
	rowTypeContents,
	rowTypeNamed,
	rowTypesOf,
	secondOf,
	touched,
	versionFor
} from "#test/pg/migrate/functions.fixtures.ts"
import { driftedOf } from "#test/pg/migrate/recorded-drift.fixtures.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { refusal, sameCatalog } from "#test/support/pg/migrate/support.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** What a drift check's mismatch names of each plant: the source of the function created again, the function made
 * STRICT, the privilege granted, the attribute added. */
const plantNamed = {
	"a body edited": "source of function",
	"a null input altered": "helper",
	"a table privilege": "SELECT",
	"a row type altered": "planted"
} as const

/** Declared functions migrate, drift and grant as the snapshot says, their source byte for byte, and read no table. */
export const declaredFunctions = property.explore(functionCaseSpace, {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: features satisfies ReadonlyArray<Reached<FunctionFeature>>,
	budget: { runs: 24, steered: features.length },
	check:
		({ caseSubstrate }, cx: Case<FunctionFeature>) =>
		(c) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						for (const feature of reached(c)) {
							cx.note(feature)
						}
						const second = secondOf(c)
						const m = yield* migrated({
							label: "functions",
							schemaName: { kind: "unique" },
							first: versionFor(c, c.first),
							later: [versionFor(c, second)],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: noObservation
						})
						const levels = mapNonEmpty(m.installation.names.levels, identifierOf)
						const schemaName = Arr.lastNonEmpty(levels)
						const installed = yield* installedFunctions(m.owner, schemaName)
						const contents = yield* rowTypeContents(m.owner, schemaName)
						assert.deepEqual(
							heldBodies(installed),
							declaredBodies(second, rowTypeNamed(contents)),
							"every declared function's source, as PostgreSQL stores it, digests to its declared body, each heading it names the name of the row type PostgreSQL holds of its attributes"
						)
						const signatures = yield* installedSignatures(m.owner, schemaName)
						assert.deepEqual<ReadonlyArray<string>>(
							Arr.map(signatures, rowText),
							declaredSignatures(second, rowTypeNamed(contents)),
							"every declared function's signature, as PostgreSQL holds it, is its declared one: whether it returns a set, its result's type and each argument's, a heading's row type the one PostgreSQL holds of the heading's attributes, the attributes of a field of rows an array of the row type its heading holds"
						)
						assert.deepEqual(
							touched(fatesIn(Arr.get(m.folders, 1), schemaName, declaredNames(c.first))),
							touched(fatesOf(c)),
							"the second version's migration drops, creates and replaces exactly the functions whose signature or definition it changes"
						)
						const executed = yield* publicFunctions(m.owner, schemaName)
						assert.deepEqual(Arr.map(executed, rowText), [], "PUBLIC executes no declared function")
						const owners = Arr.dedupe(Arr.map(installed, ([, , owner]) => String(owner)))
						const minted = identifierOf(
							identity.functionOwner(identifierOf(Arr.headNonEmpty(m.installation.names.levels)))
						)
						assert.ok(
							Arr.every(owners, (o) => Str.endsWith(minted)(o)),
							`every declared function is the function owner's: ${Arr.join(owners, ", ")}`
						)
						for (const owner of owners) {
							const privileges = yield* ownerTablePrivileges(m.owner, owner, levels)
							assert.deepEqual(
								Arr.map(privileges, rowText),
								[],
								"the function owner holds no privilege on any relation of the installation"
							)
						}
						for (const call of callsOf(second)) {
							const ran = yield* attempt(m.owner, [
								callOf(schemaName, call.name, call.args, call.rows)
							])
							assert.deepEqual(ran, { kind: "committed" }, `the call of ${call.name} runs`)
						}
						if (second.kind === "declares") {
							const peek = yield* attempt(m.owner, [peekCall(schemaName)])
							assert.ok(
								peek.kind === "refused" && peek.fields.code === "42501",
								`peek, which reads N, is refused for its owner's privileges: ${peek.kind === "refused" ? peek.fields.code : "it ran"}`
							)
						}
						const fresh = yield* migrated({
							label: "functions_fresh",
							schemaName: { kind: "unique" },
							first: versionFor(c, second),
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: noObservation
						})
						yield* sameCatalog(
							m.installation,
							fresh.installation,
							"the migrated second version against a fresh one"
						)
						const plant = c.plant
						if (plant === "nothing" || second.kind === "none") {
							yield* m.reapply
							return
						}
						const rowTypes = yield* rowTypesOf(m.owner, schemaName)
						const planted = plantOf(
							plant,
							schemaName,
							defined(owners[0], "the function owner of a version that declares functions"),
							Option.map(Arr.head(rowTypes), ([t]) => String(t))
						)
						if (Option.isNone(planted)) {
							yield* m.reapply
							return
						}
						yield* m.owner.query(planted.value, [])
						const failure = yield* refusal(m.reapply)
						const lines = Arr.map(driftedOf(failure), mismatchLine)
						assert.ok(
							Arr.some(lines, (l) => Str.includes(plantNamed[plant])(l)),
							`the drift check names the plant ${plant}: ${Arr.join(lines, "; ")}`
						)
					})
				),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's acceptance of each folder, its digest of each source, its privileges, the calls it runs and refuses, its catalog against a fresh installation's, and the drift check's reading of each plant"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original: "\ttype: true,\n",
			replacement: "\ttype: false,\n",
			why: "A declared function's row type is an object the drift check describes no fact of, so it neither owns nor replays its composite, its relation and its columns, and every installation of one drifts by them."
		},
		{
			file: "packages/engine/src/physical/ddl/functions.ts",
			original: '\t\t\t\t\t{ kind: "handOverFunction", name: signature, owner: ownerRole }\n',
			replacement: "",
			why: "A declared function stays the migration identity's, which owns every table, so a body that reads one runs."
		},
		{
			file: "packages/engine/src/physical/ddl/functions.ts",
			original: `\t\t\t\t\`\${text}\${"spelling" in next ? spellingText(next.spelling) : alone(rowType(next.rowType))}\${next.text}\`,\n`,
			replacement: `\t\t\t\t\`\${text}\${"spelling" in next ? spellingText(next.spelling) : ""}\${next.text}\`,\n`,
			why: "A body's named row type withheld: its placeholder installs as nothing, so a variable it declares, a cast and the source PostgreSQL stores are not the body's."
		},
		{
			file: "packages/engine/src/physical/ddl/functions.ts",
			original: `\t\t\t\t\`\${text}\${"spelling" in next ? spellingText(next.spelling) : alone(rowType(next.rowType))}\${next.text}\`,\n`,
			replacement: `\t\t\t\t\`\${text}\${"spelling" in next ? spellingText(next.spelling) : \`\${identifierOf(b.settings.levels[0])}.\${alone(rowType(next.rowType))}\`}\${next.text}\`,\n`,
			why: "A body's named row type wrong: qualified by the root level's schema, where an extension's function's row type does not stand, and the source PostgreSQL stores is not the body's."
		},
		{
			file: "packages/engine/src/ir/physical.ts",
			original:
				'\t\t\t\t\t\ttype: defined(arrayOf(f.type.rowType.type), "the array of a row type"),\n',
			replacement: "\t\t\t\t\t\ttype: f.type.rowType.type,\n",
			why: "A heading's field of rows flattened to one row: its attribute is its heading's row type, not an array of it, so the array of rows a body builds for it is refused where it is cast, and the row type PostgreSQL holds is not the heading's."
		},
		{
			file: "packages/engine/src/ir/physical.ts",
			original:
				"\t\t\t\treturn [{ name: f.name, type: f.type.rowType.type, collation: undefined }]\n",
			replacement: "\t\t\t\treturn f.type.rowType.attributes\n",
			why: "A heading's field of one row flattened into it: the held heading's attributes stand in the holding row type in its place, so the row a body builds for it is refused where it is cast, and the row type PostgreSQL holds is not the heading's."
		},
		{
			file: "packages/engine/src/physical/ddl/functions.ts",
			original: '\t\t\treturned.kind === "rows"\n',
			replacement: '\t\t\treturned.kind !== "value"\n',
			why: "A result of one row installed as a set of rows, so a PL/pgSQL body that returns its row is refused as it is created (RETURN cannot have a parameter in function returning set)."
		},
		{
			file: "packages/engine/src/physical/ddl/functions.ts",
			original: '\t\t\t\tcase "row":\n\t\t\t\t\treturn rowType(t.heading)\n',
			replacement:
				'\t\t\t\tcase "row":\n\t\t\t\t\treturn defined(arrayOf(rowType(t.heading)), "the array of a row type")\n',
			why: "An argument of one row wrapped in an array of one, so a body's call passing the row finds no function of its signature (42883)."
		},
		{
			file: "packages/engine/src/physical/ddl/functions.ts",
			original: "\t\t\t[levelNode, owner, ...used, ...callees]\n",
			replacement: "\t\t\t[levelNode, owner, ...used]\n",
			why: "Declared functions are created in name order, whatever they call, so an SQL body is validated before the helper it calls stands, which PostgreSQL refuses (42883)."
		}
	]
})
