/**
 * Every law carries its catalog entry (types/changeset LawEntry) to every place that names it: the entry its statements'
 * author declares at the statement, law({ name, source }, statement), or, where none does, the one grizzle derives from
 * what the law states, each with its name and its source.
 *
 * Each case draws a schema of every law kind as lawsOf's property draws it (laws.fixtures.ts caseGen: a family core of
 * ordered and counted families, trees and folds, beside tables with keys, selected keys, checks, containments,
 * mirrors, coverages, contracts, text patterns, generated fields and an alternatives law, on one level or two), and
 * at each of its statements a catalog entry or none, drawn from entries whose texts JSON escapes: quotes, a reverse
 * solidus, controls and astral characters.
 *
 * The oracle is the case's own declarations, read through the naming door: each statement's laws, as the unnamed schema's
 * installation states them (laws.fixtures.ts statedBy), each by its identity text. A law any of whose statements
 * declares an entry carries that entry, `declared`, with its name and source as written; every other law the entry
 * grizzle derives from what it states, `derived`. Two statements of one law, or two copies of one statement, that
 * declare two entries are refused (MalformedDescription), a unit's copies among them, which state no law but carry one
 * entry, keyed by the unit's own text; and so is law(...) of a mutable, which states no law, and of a statement
 * law(...) has named already. Every place a law is named carries the expected entry:
 *
 * - lawsOf and lawsByStatement, the schema's identity sites;
 * - the classifier a served Db reads PostgreSQL's refusals through (adapter/served/refusals.ts installationWitness): a
 *   violation of every constraint the installation lists, a table's or a domain's, naming every law it serves; a write
 *   statement's raised refusal of every law of the theory; a generated column's NOT NULL;
 * - on two levels, snapshot.json written and read back as a Db over the base serves it (adapter/boundary/snapshot.ts
 *   parseSnapshot, witness/keylaw.ts lawsAbove): each law of the level above, and the classifier of the base naming
 *   each as an `above` refusal of every constraint of the level above.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { parseSnapshot } from "#adapter/boundary/snapshot.ts"
import { installationWitness } from "#adapter/served/refusals.ts"
import type { WrittenAt } from "#adapter/witness/classify.ts"
import { lawsAbove, noLevelAbove } from "#adapter/witness/keylaw.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import {
	derivedOf,
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsByStatement, lawsOf } from "#compiler/program/laws.ts"
import { namedAbove } from "#compiler/runtime/law-entry.ts"
import { lawBuilder } from "#compiler/schema/law-entries.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { succeeded, throwsRefused } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { installationOf } from "#test/support/kernel/naming.ts"
import { encodeRefusalDetail } from "#test/support/oracle/write/detail.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { keyValueGen } from "#test/unit/adapter/witness.fixtures.ts"
import {
	builtInstallationOf,
	catalogAt,
	cataloguedDeclarations,
	cataloguedEntries,
	type EntriesCase,
	entriesCaseGen,
	expectedEntry,
	namedSubjectOf,
	sameEntry,
	statedText,
	statementsOf,
	statesLaws,
	unitText
} from "#test/unit/program/law-entries.fixtures.ts"
import { lawKinds, statedBy, subjectOf } from "#test/unit/program/laws.fixtures.ts"

/** What a case reaches: each place a law is named, each kind of entry, each refusal of a declaration, each law kind. */
type EntriesFeature =
	| "a declared entry"
	| "a derived entry"
	| "one entry declared at two statements of one law"
	| "two entries for one law refused"
	| "a mutable refused"
	| "an entry given twice refused"
	| "lawsOf"
	| "lawsByStatement"
	| "a table constraint's refusal"
	| "a domain's refusal"
	| "a statement's raised refusal"
	| "a generated field's refusal"
	| "a law above, read back from snapshot.json"
	| "a refusal by a law above"
	| "a relation's declared primary-key entry"
	| "a generated field's declared entry"
	| "one type's declared entry at its two fields"
	| "a contract's declared entry"
	| "a builtin contract's declared entry"
	| "an accumulated field of an entried type"
	| (typeof lawKinds)[keyof typeof lawKinds]

/** A refused statement that wrote nothing the host judges: PostgreSQL's refusal names its laws, the host none. */
const unjudged: WrittenAt = {
	relations: [],
	judge: () => ({ witness: { kind: "unreported" }, laws: { kind: "object" } }),
	above: () => ({ own: "unjudged" })
}

export const everyLawCarriesTheCatalogEntryItsDeclarationStatesToEveryPlaceThatNamesIt =
	property.explore(entriesCaseGen, {
		needs: {},
		situations: [
			"a declared entry",
			"a derived entry",
			"one entry declared at two statements of one law",
			"two entries for one law refused",
			"a mutable refused",
			"an entry given twice refused",
			"lawsOf",
			"lawsByStatement",
			"a table constraint's refusal",
			"a domain's refusal",
			"a statement's raised refusal",
			"a generated field's refusal",
			"a law above, read back from snapshot.json",
			"a refusal by a law above",
			"a relation's declared primary-key entry",
			"a generated field's declared entry",
			"one type's declared entry at its two fields",
			"a contract's declared entry",
			"a builtin contract's declared entry",
			"an accumulated field of an entried type",
			...Rec.values(lawKinds)
		] satisfies ReadonlyArray<Reached<EntriesFeature>>,
		check: (_2, k: Case<EntriesFeature>) => (c: EntriesCase) =>
			Effect.sync(() => {
				const stated = statedBy(
					installationOf(
						subjectOf(c.laws, (items) => items),
						{ kind: "declared" }
					)
				)
				/** Each law's identity text, with the catalog entries its statements declare. */
				const declaredBy = new Map<string, ReadonlySet<number>>()
				for (const [at, statement] of statementsOf(c.laws).entries()) {
					const declared = c.declared[at] ?? Option.none<number>()
					if (Option.isNone(declared)) {
						continue
					}
					if (!statesLaws(statement)) {
						throwsRefused(
							() => lawBuilder(catalogAt(declared.value), statement),
							"MalformedDescription",
							"law(...) of a statement that states no law is refused"
						)
						k.note("a mutable refused")
						continue
					}
					/** What its entry is keyed by: a unit's own text, its copies' alike, since a unit states no law; else each
					 * law's identity text. */
					const keyed = Option.match(unitText(statement), {
						onSome: (text): ReadonlyArray<string> => [text],
						onNone: () =>
							Arr.map(
								Option.getOrThrowWith(
									stated(statement),
									() => new Error(`the installation states the case's ${statement.kind}`)
								),
								statedText
							)
					})
					for (const text of keyed) {
						const known = declaredBy.get(text) ?? new Set<number>()
						if (known.has(declared.value)) {
							k.note("one entry declared at two statements of one law")
						}
						declaredBy.set(text, new Set([...known, declared.value]))
					}
				}
				if (Arr.some([...declaredBy.values()], (entries) => entries.size > 1)) {
					throwsRefused(
						() => lawsOf(namedSubjectOf(c).subject),
						"MalformedDescription",
						"two statements of one law, or two copies of one statement, that declare two entries are refused"
					)
					k.note("two entries for one law refused")
					return
				}
				const declared = new Map([
					...Arr.flatMap([...declaredBy], ([text, entries]) =>
						Arr.map(Arr.take([...entries], 1), (entry) => [text, entry] as const)
					),
					...cataloguedEntries(c.catalogued)
				])
				const { base, subject, statements } = namedSubjectOf(c)
				/** `l`, as `site` names it, carries the entry its declaration states. */
				const named = (l: Law, site: string): void => {
					if (l.kind === "above") {
						return assert.fail(
							`${site} names a law of the schema's own as a law above: ${Formatter.format(l)}`
						)
					}
					const expected = expectedEntry(declared, l)
					assert.ok(
						sameEntry(l.entry, expected),
						`${site} names the ${l.kind} law ${Formatter.format(l)} with the entry ${Formatter.format(expected)}`
					)
					k.note(l.entry.kind === "declared" ? "a declared entry" : "a derived entry")
				}

				const listed = lawsOf(subject)
				for (const identified of listed) {
					named(identified.law, "lawsOf")
					k.note(lawKinds[identified.law.kind])
					const l = identified.law
					if (l.entry.kind === "declared") {
						switch (l.kind) {
							case "primaryKey":
								k.note("a relation's declared primary-key entry")
								break
							case "generated":
								k.note("a generated field's declared entry")
								break
							case "contract":
								k.note(
									l.contract === "natural"
										? "a builtin contract's declared entry"
										: "a contract's declared entry"
								)
								break
							case "pattern":
								if (l.relation === "CatalogDoc") {
									k.note("an accumulated field of an entried type")
								}
								break
							case "key":
							case "check":
							case "contained":
							case "coverage":
							case "family":
							case "tree":
							case "fold":
							case "sealed":
								break
						}
					}
				}
				if (
					Arr.filter(
						listed,
						({ law: l }) =>
							l.kind === "pattern" && l.relation === "Catalogued" && l.entry.kind === "declared"
					).length === 2
				) {
					k.note("one type's declared entry at its two fields")
				}
				for (const declaration of cataloguedDeclarations(c.catalogued)) {
					throwsRefused(
						() => lawBuilder(catalogAt(0), declaration),
						"MalformedDescription",
						"law(...) of a declaration law(...) has named is refused"
					)
				}
				k.note("lawsOf")
				const lookup = lawsByStatement(subject)
				for (const statement of statements) {
					for (const l of lookup(statement)) {
						named(l, "lawsByStatement")
					}
				}
				k.note("lawsByStatement")
				const lawful = Arr.findFirst(statements, statesLaws)
				if (Option.isSome(lawful)) {
					throwsRefused(
						() => lawBuilder(catalogAt(0), lawBuilder(catalogAt(1), lawful.value)),
						"MalformedDescription",
						"law(...) of a statement law(...) has named is refused"
					)
					k.note("an entry given twice refused")
				}

				const artifacts = succeeded(testArtifacts(subject, testCompile))
				const witness = installationWitness(artifacts, noLevelAbove)
				const schemaName = artifacts.names.schema
				/** The laws the classifier names of a refusal PostgreSQL reports with `fields`. */
				const classified = (
					fields: Partial<typeof nothingReported> & { readonly sqlstate: string },
					written: WrittenAt,
					what: string
				): ReadonlyArray<Law> => {
					const violation = witness.classify(
						serverError({ ...nothingReported, ...fields }),
						written
					)
					if (violation?.kind !== "rejected") {
						return assert.fail(`${what} is a law's refusal: ${Formatter.format(violation)}`)
					}
					return Arr.map(refusedEntries(violation.refused), (r) => r.law)
				}
				for (const constraint of artifacts.constraintLaws) {
					const table = constraint.kind === "constraint" || constraint.kind === "trigger"
					for (const l of classified(
						{
							sqlstate: sqlstates.checkViolation,
							constraint: constraint.name,
							schema: schemaName,
							...(table ? { table: constraint.owner } : { dataType: constraint.owner })
						},
						unjudged,
						`a violation of ${constraint.name}`
					)) {
						named(l, `the classifier's refusal by ${constraint.name}`)
					}
					k.note(table ? "a table constraint's refusal" : "a domain's refusal")
				}
				const refusable = Arr.findFirst([...artifacts.derived.schema.relations.values()], (r) =>
					Arr.every(r.primaryFields, (f) => keyValueGen(artifacts, f) !== undefined)
				)
				if (Option.isSome(refusable)) {
					const relation = refusable.value
					for (const theoryLaw of artifacts.theoryLaws) {
						const detail = encodeRefusalDetail(
							{ kind: "law", relation: relation.name },
							Arr.map(relation.primaryFields, (f) => ({
								field: f.name,
								text: k.draw(defined(keyValueGen(artifacts, f), "a key value")).text
							}))
						)
						for (const l of classified(
							{
								sqlstate: sqlstates.integrityConstraintViolation,
								constraint: theoryLaw.law,
								schema: schemaName,
								detail
							},
							unjudged,
							`a write statement's refusal of ${theoryLaw.law}`
						)) {
							named(l, "the classifier's raised refusal")
						}
						k.note("a statement's raised refusal")
					}
				}
				for (const relation of artifacts.derived.schema.relations.values()) {
					for (const field of relation.fields) {
						if (field.writing.kind !== "generated") {
							continue
						}
						for (const l of classified(
							{
								sqlstate: sqlstates.notNullViolation,
								schema: schemaName,
								table: artifacts.names.relation(relation.name).name,
								column: field.column
							},
							{ ...unjudged, relations: [relation.name] },
							`a NULL in the generated ${relation.name}.${field.name}`
						)) {
							named(l, "the classifier's generated refusal")
						}
						k.note("a generated field's refusal")
					}
				}

				if (c.laws.levels.kind === "above") {
					const whole = builtInstallationOf(subject)
					const snapshot = succeeded(
						finishSnapshot(
							succeeded(
								targetState({ installation: whole, workload: noWorkload, checks: lawChecks(whole) })
							)
						)
					)
					const files = succeeded(writeSnapshot(snapshot, derivedOf(whole)))
					const served = succeeded(parseSnapshot(snapshotJson(files.snapshot), 0))
					const above = lawsAbove(served)
					for (const aboveLaw of above.laws.values()) {
						named(namedAbove(aboveLaw).law, "snapshot.json's law above, read back")
						k.note("a law above, read back from snapshot.json")
					}
					const baseArtifacts = succeeded(testArtifacts(base, testCompile))
					const baseWitness = installationWitness(baseArtifacts, above)
					/** The base's own objects, each by its owner and name: a refusal by one names the base's own laws. */
					const baseOwns = new Set(
						Arr.map(baseArtifacts.constraintLaws, (c) => `${c.owner} ${c.name}`)
					)
					const aboveSchema = defined(served.schemas[1], "the level above's schema")
					const owned = [
						...Arr.map(Rec.toEntries(served.constraintToLaw.tables), ([owner, constraints]) => ({
							owner: { table: owner },
							constraints
						})),
						...Arr.map(Rec.toEntries(served.constraintToLaw.domains), ([owner, constraints]) => ({
							owner: { dataType: owner },
							constraints
						}))
					]
					for (const { owner, constraints } of owned) {
						for (const [constraint, ids] of Rec.toEntries(constraints)) {
							const ownerName = "table" in owner ? owner.table : owner.dataType
							if (
								!Arr.some(ids, (id) => above.laws.has(id)) ||
								baseOwns.has(`${ownerName} ${constraint}`)
							) {
								continue
							}
							const violation = baseWitness.classify(
								serverError({
									...nothingReported,
									sqlstate: sqlstates.checkViolation,
									constraint,
									schema: aboveSchema,
									...owner
								}),
								unjudged
							)
							if (violation?.kind !== "rejected" || violation.refused.kind !== "above") {
								return assert.fail(
									`a violation of ${constraint} above is an above refusal: ${Formatter.format(violation)}`
								)
							}
							for (const refused of violation.refused.above) {
								named(refused.law.law, `the base's refusal by ${constraint} above`)
							}
							k.note("a refusal by a law above")
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the case's own catalog entries at its statements, read through the naming door's laws of each statement, and the derivation of every other law's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/law-entry.ts",
				original:
					'export const namedLaw = (law: RecordedLaw): OwnLaw => ("entry" in law ? law : derivedLaw(law))',
				replacement: "export const namedLaw = (law: RecordedLaw): OwnLaw => derivedLaw(law)",
				why: "A law whose statements' author declares its entry is named by the entry grizzle derives."
			},
			{
				file: "packages/engine/src/runtime/law-entry.ts",
				original: '\tentry.kind === "declared" ? Object.freeze({ ...law, entry }) : law',
				replacement: "\tlaw",
				why: "No artifact records an author's entry, so every law is read with its derived one."
			},
			{
				file: "packages/engine/src/runtime/law-entry.ts",
				original: "law: namedLaw(above.law)",
				replacement: "law: derivedLaw(above.law)",
				why: "A law of a level above is named by its derived entry, its author's dropped."
			},
			{
				file: "packages/grizzle/src/adapter/witness/classify.ts",
				original:
					"const refused = (l: DescribedLaw): RefusedLaw => ({ law: namedLaw(l.described), id: l.law, by })",
				replacement:
					'const refused = (l: DescribedLaw): RefusedLaw => ({ law: { ...namedLaw(l.described), entry: { ...namedLaw(l.described).entry, source: "" } }, id: l.law, by })',
				why: "A native refusal drops the source of each law it names."
			},
			{
				file: "packages/engine/src/schema/law-entries.ts",
				original: '\treturn Object.freeze({ kind: "declared", name, source })',
				replacement: '\treturn Object.freeze({ kind: "declared", name, source: name })',
				why: "law(...) keeps the entry's name for its source."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\tthis.#statements[known] = { ...first, entry: merged }",
				replacement: "\t\t\t\tthis.#statements[known] = first",
				why: "A statement written again keeps its first copy's entry, so the entry a later copy declares is lost."
			},
			{
				file: "packages/engine/src/schema/law-entries.ts",
				original: "\t\t\t\tatField(patterns, name, field, typeEntry)",
				replacement:
					'\t\t\t\tatField(patterns, name, field, { ...typeEntry, name: typeEntry.name + " " + field })',
				why: "A text type's declared entry is one per field it types, where it is the type's one entry."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: "\t\t\t\t? this.owned.declared.primaryKeys.get(detail.relation)",
				replacement: "\t\t\t\t? undefined",
				why: "A relation's declared entry for its primary key is dropped, the key named by its derived one."
			},
			{
				file: "packages/engine/src/analysis/theory/description.ts",
				original: "\t\t\t\t\t\t\t\tfieldEntry(declared, relation.name, field.name)",
				replacement: "\t\t\t\t\t\t\t\tundefined",
				why: "A generated field's declared entry is dropped, its law named by its derived one."
			},
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					"described: recordedLaw(contractLaw(contract), declared.get(contract) ?? derivedStatement)",
				replacement: "described: recordedLaw(contractLaw(contract), derivedStatement)",
				why: "A contract's domain names its law by its derived entry, its author's dropped."
			},
			{
				file: "packages/engine/src/scalar/registry.ts",
				original:
					'\townedText.has(value) || (isOwnedDescriptor(value) && value.desc.kind === "contract")',
				replacement:
					'\townedText.has(value) || (typeof value === "function" && isOwnedDescriptor(value) && value.desc.kind === "contract")',
				why: "A contract that is no brand constructor, grizzle's own natural, takes no entry: law(...) of it is refused."
			},
			{
				file: "packages/engine/src/schema/law-entries.ts",
				original: "\t\t\tconst type = writtenTypeOf(member) ?? member",
				replacement: "\t\t\tconst type = member",
				why: "A field of a writing of its own reads none of its type's entry: an accumulated field's pattern law is derived where its type declares one."
			},
			{
				file: "packages/engine/src/schema/declared-entries.ts",
				original:
					'\treturn b.kind === "derived" || (a.name === b.name && a.source === b.source) ? a : undefined',
				replacement: "\treturn a",
				why: "Two statements of one law, or two copies of one statement, that declare two entries are admitted, the first kept."
			}
		]
	})
