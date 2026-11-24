/**
 * lawsOf(schema) lists exactly the laws the schema's installation can report, each once, in the schema's canonical order.
 *
 * Each case draws a schema of one or two levels: a family core as the family swarm draws it (test/pg/write/swarm/spec.ts:
 * ordered and counted families, trees, folds of every monoid, copies along every axis, generated fields, plain sets and
 * referrers, keys, checks, containments and selections over copies, mutable relations), beside tables under names drawn
 * apart from name order, each keyed by its id or by its id and a span of a checked contract, with fields drawn apart
 * from name order: texts of a palette pattern spelled plainly, with every atom grouped, or respelled as a longer run of
 * the same language, so one domain comes in spellings whose CHECKs differ and tautologies such as `^.*$` under `su` come
 * up beside refined patterns; contracts over a palette pattern; integers; two bigint contracts of one definition, which
 * share a domain with the span's; and a contract that refines nothing; and generated integers and refined texts read
 * from those fields. Statements over the tables key an integer, key a selection, check a row, contain one table's ids
 * in another's, mirror two tables, cover one table's spans by another's and make a table mutable, a statement drawn
 * twice standing twice; an alternatives law over a roster, a closed relation of a palette pattern's payload and a
 * sealed unit over two relations may stand beside them. On two levels the tables stand above the core, which
 * may restate core statements.
 *
 * The oracle is the installation's own constraint-to-law map (adapter/witness/keylaw.ts keyLawsOf), the map a refusal is
 * read through: the laws of every table constraint, unique index and domain constraint the install script creates, read
 * under the table or domain that owns it as PostgreSQL reports a violation; every law a write statement's refusal
 * raises; the generated law of every column the script creates; and the seal law of every seal trigger it creates. Every law it can report is in lawsOf exactly once,
 * by sameLaw, and lawsOf holds no law it cannot report. The order is held to the case's declarations: lawsOf opens with
 * each ordinary relation's primary key by relation name, as the relation declares it, and closes with the pattern law of
 * every stored text field whose column a planned text domain types, spelled as the case declares it (a core tree's
 * root texts, on its relation and on the members of a family it owns, among them: fill.ts rootTextFieldsOf), then the
 * law of every generated field, each by relation name and each relation's fields in declared order, then the sealed unit's
 * seal law; between them every contract's law follows every statement's, by contract name; and the same schema declared in another order of its
 * relations and statements lists the same laws in the same order. Planted in a scratch copy, lawsOf leaving out the
 * primary keys, the pattern laws or the generated laws, listing a law twice, or ordering the pattern laws by declaration
 * each fail it.
 *
 * lawsByStatement(schema) looks up exactly the laws each statement states. The oracle is the naming door and the
 * installation: each owned statement a statement value is (a mirrors' two containments), owned alone over the schema's
 * levels and matched among the schema's owned statements by identity text, and every law of the installation's theory
 * that holds one, as the installation describes the law its objects report. Every statement of the schema, and every
 * statement of its twin built again in another order, gives exactly those laws, in lawsOf's order, each one the
 * installation can report; every law lawsOf lists
 * is some statement's, a primary key's, a contract's, a pattern's or a generated field's, and every statement's law is
 * one lawsOf lists. A statement of another drawn schema gives the laws the installation's theory holds for it when this
 * schema states it, and is refused as MalformedDescription when it does not, as is a copy of a statement no builder
 * made. Planted in a scratch copy, a mirrors giving only its first containment fails it.
 *
 * A key restating a table's primary key holds apart the rows its primary key holds apart, so a schema that states one
 * is refused as MalformedDescription (schema/own.ts distinctKeys): lawsOf refuses the same case with a key over its
 * first table's primary key added.
 *
 * constraintNamesOf(schema) gives each check law lawsOf lists the name the installation reports it under on its
 * relation's table, through the same constraint-to-law map.
 *
 * lawsOf(schema) gives each law an id of its own, and every law the installation's map reports, under every id it
 * reports it by, is one of them with that id: a refusal's RefusedLaw.id finds its law there.
 *
 * Every reader of one schema value reads one compiled state of it (program/schema.ts compiledSchema): lawsOf,
 * constraintNamesOf, lawsByStatement, rowEvaluator and two insertPreviews of the same value compile its laws once between
 * them, derive its laws once and compile its family inserts once, the count work, never time (kernel/calls.ts
 * callCounts).
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { constraintNamesOf, lawsByStatement, lawsOf } from "#compiler/program/laws.ts"
import { previewOver } from "#compiler/program/preview.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import { type AnyRelation } from "#compiler/public/schema.ts"
import { derivedEntry, derivedLaw } from "#compiler/runtime/law-entry.ts"
import { constraintLawsOf } from "#compiler/runtime/write/laws.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import type { OwnLaw } from "#compiler/types/changeset/changeset.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { relationName, rootTextFieldsOf, rootTextPattern } from "#test/support/families/fill.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { identityText, installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import {
	caseGen,
	declaredFields,
	lawKinds,
	type LawsFeature,
	lawText,
	levelsOf,
	ownedAs,
	type PatternLaw,
	reordered,
	reportable,
	reportsCheckAs,
	type Spelled,
	sameLawText,
	statedBy,
	subjectOf
} from "#test/unit/program/laws.fixtures.ts"

/** LawsOf lists exactly the laws the installation can report, each once, in the schema's canonical order. Its budget is its suite's before it was a property (test/unit/program/laws.test.ts at 4ca3036a): 120 runs and 120 steered cases. */
export const lawsOfListsExactlyTheLawsTheInstallationCanReportEachOnceInTheSchemasCanonicalOrder =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: [
			"a pattern grizzle erases",
			"one domain over two fields",
			"one domain spelled two ways",
			"a contract over a pattern",
			"two contracts of one domain",
			"a contract that refines nothing",
			"a generated refined text",
			"a key restating the primary key refused",
			"a mirrors",
			"an alternatives law",
			"a statement declared twice",
			"a statement restated a level above",
			"a level above",
			"another order listing the same laws",
			"a statement stating no law",
			"a law two statements state",
			"an equal statement built again",
			"a statement of another schema stated here",
			"a statement of another schema refused",
			"a value no builder made refused",
			"a check's installed name",
			...Rec.values(lawKinds)
		] satisfies ReadonlyArray<Reached<LawsFeature>>,
		check: (_2, k: Case<LawsFeature>) => (c) =>
			Effect.gen(function* () {
				if (Arr.isReadonlyArrayNonEmpty(c.tables)) {
					throwsRefused(
						() =>
							lawsOf(
								subjectOf(
									{ ...c, statements: [...c.statements, { kind: "primary key", table: 0 }] },
									(items) => items
								)
							),
						"MalformedDescription",
						"a key restating its table's primary key is refused"
					)
					k.note("a key restating the primary key refused")
				}
				const subject = subjectOf(c, (items) => items)
				const [ids, compiles] = yield* callCounts(
					Effect.sync(() => {
						const listed = lawsOf(subject)
						constraintNamesOf(subject)
						lawsByStatement(subject)
						rowEvaluator(subject)
						previewOver(subject, inForce(bindFrame))
						previewOver(subject, inForce(bindFrame))
						return listed
					}),
					{
						models: { file: "packages/engine/src/laws/model/model.ts", name: "dischargedLaws" },
						laws: { file: "packages/engine/src/program/laws.ts", name: "derivedLaws" },
						inserts: { file: "packages/engine/src/program/preview.ts", name: "familyInsertsMade" }
					}
				)
				assert.equal(
					compiles.models,
					1,
					"lawsOf, constraintNamesOf, lawsByStatement, rowEvaluator and insertPreview of one schema value compile its laws once"
				)
				assert.equal(
					compiles.laws,
					1,
					"lawsOf, constraintNamesOf and lawsByStatement of one schema value derive its laws once"
				)
				assert.equal(
					compiles.inserts,
					1,
					"two insertPreviews of one schema value compile its family inserts once"
				)
				const laws = Arr.map(ids, (l) => l.law)
				const installation = installationOf(subject, { kind: "declared" })
				const names = installationNamesOf(installation)
				const identified = reportable(installation)
				const reported = Arr.map(identified, (r) => r.law)
				const lawTexts = Arr.map(laws, lawText)
				const reportedTexts = Arr.map(reported, lawText)
				const constraintNameOf = constraintNamesOf(subject)
				for (const law of laws) {
					if (law.kind === "check") {
						assert.ok(
							reportsCheckAs(installation, law, constraintNameOf(law)),
							`the installation reports the check ${Formatter.format(law)} under the name constraintNamesOf gives it`
						)
						k.note("a check's installed name")
					}
				}

				for (const [i, law] of laws.entries()) {
					const text = lawText(law)
					assert.equal(
						Arr.filter(lawTexts, (other) => sameLawText(text, other)).length,
						1,
						`lawsOf lists its ${law.kind} law at ${String(i)} once`
					)
					assert.ok(
						Arr.some(reportedTexts, (r) => sameLawText(text, r)),
						`the installation can report lawsOf's ${law.kind} law at ${String(i)}: ${Formatter.format(law)}`
					)
					k.note(lawKinds[law.kind])
				}
				for (const law of reported) {
					const text = lawText(law)
					assert.ok(
						Arr.some(lawTexts, (l) => sameLawText(text, l)),
						`lawsOf lists the ${law.kind} law the installation can report: ${Formatter.format(law)}`
					)
				}
				assert.equal(
					new Set(Arr.map(ids, (l) => l.id)).size,
					ids.length,
					"lawsOf gives every law an id of its own"
				)
				for (const r of identified) {
					assert.ok(
						Arr.some(ids, (l) => l.id === r.id && sameLaw(l.law, r.law)),
						`lawsOf gives the ${r.law.kind} law the installation reports under ${r.id} that id: ${Formatter.format(r.law)}`
					)
				}

				const { base, above } = levelsOf(c)
				const relations = Arr.sort(
					Arr.flatMap([base, ...Option.toArray(above)], (level) =>
						Arr.flatMap(level.relations, ([, r]): ReadonlyArray<AnyRelation> =>
							r.kind === "relation" ? [r] : []
						)
					),
					Order.mapInput(Order.String, (r: AnyRelation) => r.name)
				)
				const primaryKeys = Arr.map(relations, (r): OwnLaw =>
					derivedLaw({
						kind: "primaryKey",
						relation: r.name,
						fields: r.primaryKey
					})
				)
				const domainAt = (relation: string, field: string) =>
					Arr.findFirst(names.installation.textDomains, (d) =>
						Arr.some(
							d.uses,
							(u) =>
								u.table === names.tableIdent({ name: relation }) &&
								u.column === names.columnIdent({ name: relation }, field)
						)
					)
				const tableAt = (name: string) => Arr.findFirst(c.tables, (t) => t.name === name)
				const patternLaw = (
					relation: string,
					field: string,
					pattern: Spelled
				): ReadonlyArray<PatternLaw> => {
					const stated = {
						kind: "pattern",
						relation,
						field,
						patterns: [{ source: pattern.source, flags: pattern.flags }]
					} as const
					return Option.isSome(domainAt(relation, field))
						? [{ ...stated, entry: derivedEntry(stated) }]
						: []
				}
				const coreAt = (name: string) =>
					Arr.findFirstIndex(c.core.fill.relations, (_, i) => relationName(i) === name)
				const patterns = Arr.flatMap(relations, (r) =>
					Option.match(tableAt(r.name), {
						onNone: () =>
							Option.match(coreAt(r.name), {
								onNone: () => [],
								onSome: (i) =>
									Arr.flatMap(rootTextFieldsOf(c.core.fill, i), (field) =>
										patternLaw(r.name, field, rootTextPattern)
									)
							}),
						onSome: (t) =>
							Arr.flatMap(declaredFields(t), ([field, pattern]) =>
								Option.isSome(pattern) ? patternLaw(r.name, field, pattern.value) : []
							)
					})
				)
				const generated = Arr.flatMap(relations, (r): ReadonlyArray<OwnLaw> => {
					const core = Arr.findFirst(c.core.fill.relations, (_, i) => relationName(i) === r.name)
					return Option.isSome(core)
						? core.value.generated.kind !== "none"
							? [derivedLaw({ kind: "generated", relation: r.name, field: "g" })]
							: []
						: Option.match(tableAt(r.name), {
								onNone: () => [],
								onSome: (t) =>
									Arr.map(t.generated, ([field]): OwnLaw =>
										derivedLaw({ kind: "generated", relation: r.name, field })
									)
							})
				})
				const seals: ReadonlyArray<OwnLaw> = c.sealed
					? [derivedLaw({ kind: "sealed", unit: "Victor" })]
					: []
				const middle = Arr.drop(
					Arr.take(laws, laws.length - patterns.length - generated.length - seals.length),
					primaryKeys.length
				)
				assert.deepEqual(
					laws,
					[...primaryKeys, ...middle, ...patterns, ...generated, ...seals],
					"lawsOf opens with the primary keys and closes with the pattern laws, then the generated fields' laws, then the sealed units' seal laws, as the case declares them"
				)
				const contracts = Arr.flatMap(middle, (l) => (l.kind === "contract" ? [l.contract] : []))
				assert.deepEqual(
					Arr.drop(middle, middle.length - contracts.length),
					Arr.map(Arr.sort(contracts, Order.String), (contract): OwnLaw =>
						derivedLaw({ kind: "contract", contract })
					),
					"every contract's law follows every statement's, by contract name"
				)
				const twin = subjectOf(c, (items) => reordered(items, c.reorder))
				assert.deepEqual(
					lawsOf(twin),
					ids,
					"the schema declared in another order lists the same laws in the same order, with the same ids"
				)
				if (
					Arr.join(Rec.keys(twin.relations), " ") !== Arr.join(Rec.keys(subject.relations), " ")
				) {
					k.note("another order listing the same laws")
				}

				const [lawsOfStatement, lookups] = yield* callCounts(
					Effect.sync(() => {
						const lookup = lawsByStatement(subject)
						for (const statement of subject.statements) {
							lookup(statement)
						}
						return lookup
					}),
					{
						laws: { file: "packages/engine/src/program/laws.ts", name: "derivedLaws" },
						texts: { file: "packages/engine/src/schema/own.ts", name: "canonicalStatement" }
					}
				)
				assert.deepEqual(
					lookups,
					{ laws: 0, texts: 0 },
					"a schema value's lawsByStatement, and its every statement looked up, derives no law and works out no statement's canonical text again"
				)
				const stated = statedBy(installation)
				const looked = Arr.map(subject.statements, (statement) => {
					const stating = lawsOfStatement(statement)
					return {
						texts: Arr.join(Arr.map(ownedAs(statement), identityText), " "),
						laws: stating,
						lawTexts: Arr.map(stating, lawText)
					}
				})
				for (const statement of [...subject.statements, ...twin.statements]) {
					const expected = Option.getOrThrowWith(
						stated(statement),
						() => new Error(`the installation states its ${statement.kind}`)
					)
					const got = lawsOfStatement(statement)
					assert.deepEqual(
						got,
						expected,
						`lawsByStatement gives the laws the installation's ${statement.kind} states, in lawsOf's order`
					)
					for (const law of got) {
						const text = lawText(law)
						assert.ok(
							Arr.some(reportedTexts, (r) => sameLawText(text, r)),
							`the installation can report the ${statement.kind}'s ${law.kind} law: ${Formatter.format(law)}`
						)
					}
					if (got.length === 0) {
						k.note("a statement stating no law")
					}
					throwsRefused(
						() => lawsOfStatement({ ...statement }),
						"MalformedDescription",
						`a copy of the ${statement.kind} no builder made is no statement of the schema`
					)
					k.note("a value no builder made refused")
				}
				if (twin.statements.length > 0) {
					k.note("an equal statement built again")
				}
				for (const [i, a] of looked.entries()) {
					for (const b of Arr.drop(looked, i + 1)) {
						if (
							a.texts !== b.texts &&
							Arr.some(a.lawTexts, (l) => Arr.some(b.lawTexts, (m) => sameLawText(l, m)))
						) {
							k.note("a law two statements state")
						}
					}
				}
				const fromStatements = Arr.flatMap(looked, (l) => l.laws)
				const unstated = [
					...primaryKeys,
					...Arr.filter(reported, (l) => l.kind === "contract"),
					...patterns,
					...generated
				]
				const knownTexts = Arr.map([...fromStatements, ...unstated], lawText)
				for (const law of laws) {
					const text = lawText(law)
					assert.ok(
						Arr.some(knownTexts, (l) => sameLawText(text, l)),
						`lawsOf's ${law.kind} law is a statement's, a primary key's, a contract's, a pattern's or a generated field's: ${Formatter.format(law)}`
					)
				}
				for (const law of fromStatements) {
					const text = lawText(law)
					assert.ok(
						Arr.some(lawTexts, (l) => sameLawText(text, l)),
						`lawsOf lists the ${law.kind} law a statement states: ${Formatter.format(law)}`
					)
				}
				for (const statement of subjectOf(c.other, (items) => items).statements) {
					Option.match(stated(statement), {
						onNone: () => {
							throwsRefused(
								() => lawsOfStatement(statement),
								"MalformedDescription",
								`a ${statement.kind} of another schema this one does not state is refused`
							)
							k.note("a statement of another schema refused")
						},
						onSome: (expected) => {
							assert.deepEqual(
								lawsOfStatement(statement),
								expected,
								`a ${statement.kind} of another schema this one states gives the laws it states here`
							)
							k.note("a statement of another schema stated here")
						}
					})
				}

				for (const t of c.tables) {
					for (const [field, f] of t.fields) {
						switch (f.kind) {
							case "text":
								if (Option.isNone(domainAt(t.name, field))) {
									k.note("a pattern grizzle erases")
								}
								break
							case "textContract":
								k.note("a contract over a pattern")
								break
							case "brand":
								k.note("a contract that refines nothing")
								break
							case "integer":
							case "count":
								break
						}
					}
					for (const [field, g] of t.generated) {
						if (g.kind === "text" && Option.isSome(domainAt(t.name, field))) {
							k.note("a generated refined text")
						}
					}
				}
				for (const domain of names.installation.textDomains) {
					const spelled = Arr.flatMap(patterns, (p) =>
						Option.exists(domainAt(p.relation, p.field), (d) => d.name === domain.name)
							? [
									Arr.join(
										Arr.map(p.patterns, (q) => q.source),
										" & "
									)
								]
							: []
					)
					if (spelled.length > 1) {
						k.note("one domain over two fields")
					}
					if (new Set(spelled).size > 1) {
						k.note("one domain spelled two ways")
					}
				}
				for (const cl of installation.constraintLaws) {
					if (
						(cl.kind === "domainConstraint" || cl.kind === "unstoredDomainConstraint") &&
						Arr.filter(constraintLawsOf(cl), (l) => l.described.kind === "contract").length > 1
					) {
						k.note("two contracts of one domain")
					}
				}
				for (const s of c.statements) {
					switch (s.kind) {
						case "mirrors":
							k.note("a mirrors")
							break
						case "primary key":
						case "key":
						case "selected key":
						case "check":
						case "contained":
						case "coverage":
						case "mutable":
							break
					}
				}
				if (new Set(Arr.map(c.statements, (s) => Formatter.format(s))).size < c.statements.length) {
					k.note("a statement declared twice")
				}
				if (c.alternatives) {
					k.note("an alternatives law")
				}
				if (c.levels.kind === "above") {
					k.note("a level above")
					if (c.levels.restated.length > 0) {
						k.note("a statement restated a level above")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the installation's constraint-to-law map, the naming door's owned statements, and the case's declared keys, patterns and generated fields"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/laws.ts",
				original: '\tschemaLaws(schema, "lawsOf").laws',
				replacement:
					'\tschemaLaws(schema, "lawsOf").laws.flatMap((l, i) => (i === 0 ? [l, l] : [l]))',
				why: "lawsOf lists its first law twice."
			},
			{
				file: "packages/engine/src/program/laws.ts",
				original: '\tschemaLaws(schema, "lawsOf").laws',
				replacement: '\tschemaLaws(schema, "lawsOf").laws.slice(1)',
				why: "lawsOf drops its first law."
			},
			{
				file: "packages/engine/src/program/laws.ts",
				original: "\treturn compiled.laws.read(() => derivedLaws(compiled.model))",
				replacement: "\treturn derivedLaws(compiled.model)",
				why: "Each of lawsOf, constraintNamesOf and lawsByStatement derives a schema's laws from its model again."
			},
			{
				file: "packages/engine/src/program/preview.ts",
				original: "\tcompiled.inserts.read(() => familyInsertsMade(schema, compiled.model))",
				replacement: "\tfamilyInsertsMade(schema, compiled.model)",
				why: "Each insertPreview of a schema value compiles its family inserts again, every set of families' insert with them."
			},
			{
				file: "packages/engine/src/core/lazy.ts",
				original: "\t\tthis.#held ??= { value: compute() }",
				replacement: "\t\tthis.#held = { value: compute() }",
				why: "A lazy value is computed at every read, so a schema value's laws and family inserts are made again by each reader."
			},
			{
				file: "packages/engine/src/schema/statements.ts",
				original:
					"\treturn statement === undefined ? undefined : [statement.content.canonical.text]",
				replacement:
					"\treturn statement === undefined ? undefined : [canonicalStatementOf(statement.desc).text]",
				why: "A lookup works out a statement's canonical text again, where the statement's value holds the one its build worked out."
			},
			{
				file: "packages/engine/src/program/schema.ts",
				original: "\tconst known = built.get(schema.value)",
				replacement:
					"\tconst known: Result.Result<CompiledSchema, CompileError> | undefined = undefined",
				why: "Each reader of a schema value compiles its law model again, so lawsOf, constraintNamesOf, rowEvaluator and insertPreview of one schema compile its laws four times."
			}
		]
	})
