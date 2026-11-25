/**
 * The drift check of a recorded snapshot, on PostgreSQL 19: manifest.json records a PL/pgSQL function by its header and
 * the SHA-256 of its source, and a constant by its header, whose name digests its content (snapshot/recorded.ts), and
 * the drift check replays each with a stub body, describes a PL/pgSQL function by its definition's header alone and
 * holds its installed source to the record's digest (adapter/admission/drift.ts).
 *
 * - **Property:** after the migration of a schema whose rule over a query installs PL/pgSQL functions whose source holds
 *   a tab, which the drafted file writes as an escape string, and a roster's names constant: with nothing planted, the
 *   drift check admits the database, and every PL/pgSQL function's source as PostgreSQL stores it digests to the
 *   record's, function by function; with a source created again under its own header, it refuses, naming that function
 *   by a source mismatch with the record's digest and the installed one, and the committed statement that defines it;
 *   with the names constant renamed, it names the constant missing and the moved one unexpected; with a constant the
 *   snapshot does not name, that one unexpected; with the names constant's header changed, made STABLE, that constant
 *   as differing.
 * - **Oracle:** PostgreSQL: its own SHA-256 of pg_proc.prosrc, the definition it deparses, and the catalog the planted
 *   statement leaves; the defining statement read off the applied folders as `grizzle check` splits them, by the text
 *   the draft files the function's CREATE as.
 * - **Box, exhausted:** each plant once, a source edited once for each kind of PL/pgSQL function the schema installs:
 *   the rule judge, a rule capture, the refusal function and the isolation guard.
 * - **Features:** each plant, each kind edited, a source holding a control character, and a constant missing,
 *   unexpected and differing.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { recordedSources } from "#compiler/deploy/admission/manifest.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	caseSpace,
	constantPlants,
	definingStatement,
	driftedOf,
	editedDefinition,
	editedKinds,
	editOf,
	holdsControlCharacter,
	installedSourcesQuery,
	names,
	namesConstant,
	plants,
	type RecordedFeature,
	versionOf
} from "#test/pg/migrate/recorded-drift.fixtures.ts"
import { refusal } from "#test/pg/migrate/support.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The drift check of a recorded snapshot admits a migrated database whose every source digests to its record, and finds a planted source and a planted constant. */
export const recordedDrift = property.exhaust(caseSpace, {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: [
		...plants,
		...Arr.map(editedKinds, (kind) => `a source edited: ${kind}` as const),
		"a source holding a control character",
		"a constant missing",
		"a constant unexpected",
		"a constant differs"
	] satisfies ReadonlyArray<Reached<RecordedFeature>>,
	check:
		({ caseSubstrate }, c: Case<RecordedFeature>) =>
		(kase) =>
			Effect.provideServiceEffect(
				Effect.scoped(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const m = yield* migrated({
							label: "recorded_drift",
							schemaName: { kind: "unique" },
							first: versionOf,
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: noObservation
						})
						const installation = m.installation
						if (holdsControlCharacter(installation)) {
							c.note("a source holding a control character")
						}
						c.note(kase.plant)
						switch (kase.plant) {
							case "nothing planted": {
								yield* m.reapply
								const held = yield* substrate.admin.queryValues(installedSourcesQuery, [m.schema])
								const expected = Arr.map(
									Arr.filter(recordedSources(m.snapshot), (r) => r.function.schema === m.schema),
									(r) => [r.function.name, r.source]
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(held, ([name, digest]) => `${String(name)} ${String(digest)}`),
										Str.Order
									),
									Arr.sort(
										Arr.map(expected, ([name, digest]) => `${name} ${digest}`),
										Str.Order
									),
									"every PL/pgSQL function's source as PostgreSQL stores it digests to the record's"
								)
								return
							}
							case "a source edited": {
								c.note(`a source edited: ${kase.kind}`)
								const edit = editOf(installation, kase.kind)
								const [definition] = yield* substrate.admin.queryValues(
									"SELECT pg_catalog.pg_get_functiondef(p.oid)::text FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = $1::text AND p.proname = $2::text",
									[edit.function.schema, edit.function.name]
								)
								yield* substrate.admin.query(
									editedDefinition(String(defined(definition?.[0], "the function's definition"))),
									[]
								)
								const failure = yield* refusal(m.reapply)
								const mismatches = driftedOf(failure)
								const recorded = Arr.findFirst(
									recordedSources(m.snapshot),
									(r) =>
										r.function.schema === edit.function.schema &&
										r.function.name === edit.function.name
								)
								const held = yield* substrate.admin.queryValues(installedSourcesQuery, [
									edit.function.schema
								])
								const installed = defined(
									Arr.findFirst(held, ([name]) => name === edit.function.name).pipe(
										Option.map(([, digest]) => String(digest)),
										Option.getOrUndefined
									),
									"the edited function's installed source digest"
								)
								assert.deepEqual(
									Arr.filter(mismatches, (x) => x.kind === "source"),
									[
										{
											kind: "source",
											fact: `source of function ${printObjectName(edit.function)}`,
											expected: Option.getOrThrow(recorded).source,
											installed,
											definedBy: definingStatement(m.folders, edit.create)
										}
									],
									"the edited function's source mismatch, with both digests and its defining statement"
								)
								assert.deepEqual(
									Arr.filter(mismatches, (x) => x.kind !== "source"),
									[],
									"no other fact differs: a source edit leaves the function's header as it was"
								)
								return
							}
							case "a constant renamed": {
								const constant = namesConstant(installation)
								yield* substrate.admin.query(constantPlants.renamed(constant), [])
								const failure = yield* refusal(m.reapply)
								const mismatches = driftedOf(failure)
								assert.ok(
									names(mismatches, "missing", constant.name),
									`the renamed constant ${constant.name} is missing`
								)
								assert.ok(
									names(mismatches, "unexpected", `${constant.name}_moved`),
									`the moved constant ${constant.name}_moved is unexpected`
								)
								c.note("a constant missing")
								c.note("a constant unexpected")
								return
							}
							case "a stray constant": {
								yield* substrate.admin.query(constantPlants.stray(m.schema), [])
								const failure = yield* refusal(m.reapply)
								const mismatches = driftedOf(failure)
								assert.ok(
									names(mismatches, "unexpected", "__stray_constant"),
									"the stray constant is unexpected"
								)
								c.note("a constant unexpected")
								return
							}
							case "a constant's header": {
								const constant = namesConstant(installation)
								yield* substrate.admin.query(constantPlants.header(constant), [])
								const failure = yield* refusal(m.reapply)
								const mismatches = driftedOf(failure)
								assert.ok(
									names(mismatches, "differs", constant.name),
									`the constant ${constant.name} under another header differs`
								)
								c.note("a constant differs")
								return
							}
						}
					})
				),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL's SHA-256 of each installed source, its deparsed definitions and the catalog a planted statement leaves, and the defining statement read off the applied folders"
	},
	box: "each plant once, a source edited once for each kind of PL/pgSQL function the schema installs",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/snapshot/recorded.ts",
			original: "\tsourceDigest(sha256Hex(wellFormed(functionSource(fn))))",
			replacement:
				'\tsourceDigest(sha256Hex(wellFormed(functionSource(fn).replaceAll("\\t", "\\\\t"))))',
			why: "A source's digest is taken over its text with each tab escaped, as a drafted file spells it, never as PostgreSQL stores it, so a body holding a tab drifts on every database."
		},
		{
			file: "packages/engine/src/sql/print.ts",
			original: `export const functionSource = (fn: PlFunction): string => \`\\n\${sourceLines(fn).join("\\n")}\\n\``,
			replacement:
				'export const functionSource = (fn: PlFunction): string => sourceLines(fn).join("\\n")',
			why: "A source's digest is taken over its block's lines without the line feeds its dollar quotes open and close, so every function drifts."
		},
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original: '\t\t\t\t\t\t\t\tresult: plpgsqlHeader(p.col("oid"), p.col("prosrc"))',
			replacement: '\t\t\t\t\t\t\t\tresult: C.catalogCall("pg_get_functiondef", [p.col("oid")])',
			why: "A PL/pgSQL function is described by its definition whole, its stub's body against the installed one's, so every migrated database drifts."
		},
		{
			file: "packages/grizzle/src/adapter/admission/drift.ts",
			original: "\t\t\t\t\t\t...Arr.map(sourced, (m) => m.mismatch),\n",
			replacement: "",
			why: "A PL/pgSQL function is judged by its header alone, so a source created again under its own header is admitted."
		}
	]
})
