/**
 * The relation, closed, derived, schema and statement constructors: each records
 * its Description, refuses a malformed JavaScript argument synchronously with MalformedDescription, and
 * returns a frozen value whose public members are exactly the public API's.
 *
 * Every property draws a well-formed declaration and plants at most one defect a JavaScript caller can write, so the
 * oracle is the constructor's documented rule (packages/engine/src/schema/relation.ts, statements.ts, schema.ts, literal.ts)
 * restated: a planted defect is refused, and a declaration without one records exactly what was written. A defect is
 * refused where the builder admits its arguments, its admission core (admitRelation, admitRoster, admitClosedRelation, ...), which a
 * declaration with no defect reaches through the builder itself.
 *
 * Oracle: each constructor's documented rule, restated over the drawn declaration and its one planted defect; binary32
 * rounding (Math.fround) and a numeric's scale for literals.
 *
 * Features: as each search names them: every planted defect of each constructor, and the well-formed declarations
 * beside them.
 */

import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	int,
	shuffled,
	uniqueArray,
	uniqueKeys,
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex as arkregex } from "arkregex"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { appendAll, maxOf } from "#compiler/core/array.ts"
import {
	conjunctsOf,
	everyFact,
	expandAlternatives,
	type LiteralDesc,
	type SelectionDesc,
	type SideDesc,
	type StatementDesc
} from "#compiler/ir/desc.ts"
import { uuid } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { literalResult } from "#compiler/schema/literal.ts"
import { own } from "#compiler/schema/own.ts"
import {
	admitClosedRelation,
	admitDerived,
	admitRelation,
	admitRoster,
	closedBuilder as closed,
	materializedDerived,
	relationBuilder as relation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import { admitSchema, schemaBuilder as schema, schemaDescOf } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	checkBuilder,
	containedBuilder,
	expansionDescOf,
	keyBuilder,
	mirrorsBuilder,
	onBuilder,
	predBuilder,
	selectBuilder,
	sideDescOf,
	statementDescOf
} from "#compiler/schema/statements.ts"
import type { RowTerm } from "#compiler/schema/terms.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyTerm } from "#compiler/types/schema/statements.ts"
import {
	assert,
	defined,
	faulted,
	matchesObject,
	nonEmpty,
	placeOf,
	refusalLoc,
	succeeded,
	throwsRefused
} from "#test/support/assert.ts"
import { whereIndex } from "#test/support/oracle/pick.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import {
	agrees,
	Alien,
	alternativesDefects,
	type AlternativesFeature,
	alternativesTags,
	built,
	builtDescriptors,
	caseGen,
	type CheckDefect,
	checkDefects,
	closedDefects,
	type ClosedFeature,
	Counted,
	D,
	distinct,
	Election,
	entryNames,
	entryValues,
	expectedLiteral,
	featureOf,
	fieldListCases,
	type FieldListFeature,
	fieldTerms,
	hostValue,
	idsOf,
	Kind,
	type LevelDefect,
	levelDefects,
	type LiteralFeature,
	literalFieldDescriptor,
	type LookAlike,
	lookAlikeOf,
	mistypedValue,
	type Mutation,
	nonEmptyGen,
	ofKind,
	operandsOf,
	payloadDescriptor,
	payloadFieldOf,
	payloadNameGen,
	type PayloadType,
	plantedConjunct,
	predicateGen,
	predicateOf,
	recorded,
	recordedExpr,
	type RelationDefect,
	relationDefects,
	relationTags,
	type RosterDefect,
	rosterDefects,
	rosterOf,
	type SchemaDefect,
	schemaDefects,
	type SideStatement,
	type Site,
	statementValues,
	Task,
	taskFields,
	Triple,
	tripleFields,
	wordGen
} from "#test/unit/schema/constructors.fixtures.ts"
import { descOf, rawClosedId, rawPg, type Row } from "#test/unit/schema/support.ts"

/** Relation requires a nonempty name, built descriptors and a nonempty, distinct primary key over its own fields, and keeps none of the caller's inputs. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const relationRequiresANonemptyNameBuiltDescriptorsAndANonemptyDistinctPrimaryKeyOverItsOwnFieldsAndKeepsNoneOfTheCallersInputs =
	property.explore(
		(source) => {
			const name = source.draw(wordGen)
			const fields = source.draw(
				uniqueArray(
					wordGen,
					(fieldName) => (again) => ({
						name: fieldName,
						descriptor: again.draw(element(builtDescriptors))
					}),
					{ min: 1, max: 4 }
				)
			)
			const names = rosterOf(Arr.map(fields, (f) => f.name))
			return {
				name,
				fields,
				key: source.draw(nonEmptyGen(element(names), 2)),
				defect: source.draw(element(Arr.append(relationDefects, "none" as const))),
				lookAlike: source.draw(element<LookAlike>(["pattern only", "plain object", "spread copy"])),
				mutation: source.draw(
					element<Mutation>(["add a field", "extend the key", "drop a field", "reverse the key"])
				)
			}
		},
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [...relationDefects, "add a field", "drop a field"] satisfies ReadonlyArray<
				Reached<RelationDefect | Mutation>
			>,
			check: (_, c: Case<RelationDefect | Mutation>) => (s) =>
				Effect.sync(() => {
					c.note(s.defect)
					const names = Arr.map(s.fields, (f) => f.name)
					const key = distinct(s.key)
					const descriptors: Record<string, FieldBase> = Rec.fromEntries(
						Arr.map(s.fields, (f) => [f.name, f.descriptor])
					)
					/** The fields a JavaScript caller hands in, a planted defect among them. */
					const fields: Record<string, unknown> = { ...descriptors }
					const name = s.defect === "an empty name" ? "" : s.name
					if (s.defect === "no fields") {
						for (const f of names) {
							delete fields[f]
						}
					}
					if (s.defect === "a look-alike descriptor") {
						fields[defined(names[0])] = lookAlikeOf(s.lookAlike)
					}
					if (s.defect === "an empty field name") {
						fields[""] = uuid
					}
					const primaryKey: Array<string> =
						s.defect === "an empty key"
							? []
							: s.defect === "an undeclared key field"
								? [...key, "no such field"]
								: s.defect === "a repeated key field"
									? [...key, defined(key[0])]
									: [...key]
					const lookAlike = { kind: "relation", name, fields, primaryKey }
					if (s.defect !== "none") {
						throwsRefused(
							() =>
								admitRelation(
									name,
									fields,
									primaryKey,
									s.defect === "a fourth argument" ? [{}] : []
								),
							relationTags[s.defect]
						)
						if (s.defect !== "a fourth argument") {
							throwsRefused(() => relationDescOf(lookAlike, "look-alike"), relationTags[s.defect])
						}
						return
					}
					const R = relation(name, descriptors, primaryKey, [])
					const desc = relationDescOf(R, "test")
					assert.deepEqual(recorded(R, "test"), { name, fields: names, primaryKey: key })
					assert.deepEqual(recorded(lookAlike, "look-alike"), {
						name,
						fields: names,
						primaryKey: key
					})
					c.note(s.mutation)
					switch (s.mutation) {
						case "add a field":
							descriptors["added"] = uuid
							break
						case "extend the key":
							primaryKey.push("added")
							break
						case "drop a field":
							delete descriptors[defined(names[0])]
							break
						case "reverse the key":
							primaryKey.reverse()
							break
					}
					assert.deepEqual(Rec.keys(R.fields), names)
					assert.deepEqual(R.primaryKey, key)
					assert.deepEqual(relationDescOf(R, "test"), desc)
				}),
			oracle: {
				kind: "specification",
				name: "the relation constructor's contract: a nonempty name, built descriptors, a distinct key over its fields"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/relation.ts",
					original:
						"\t\t\tprimaryKey: frozenTuple<PrimaryKey>(primaryKey),\n\t\t\tfact: record<[Fields]>(copied),",
					replacement: "\t\t\tprimaryKey,\n\t\t\tfact: record<[Fields]>(copied),",
					why: "A relation keeps the caller's primary key array (schema/relation.ts relation)."
				}
			]
		}
	)

/** Closed records a roster's handles in declared order, types each handle as a code of its roster, and refuses every other roster. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const closedRecordsARostersHandlesInDeclaredOrderTypesEachHandleAsACodeOfItsRosterAndRefusesEveryOtherRoster =
	property.explore(
		(source) => {
			const handles = rosterOf(
				source.draw(
					uniqueKeys(matching(arkregex("^[A-Z][a-z]{0,6}$")), {
						min: 1,
						max: 4
					})
				)
			)
			return {
				name: source.draw(wordGen),
				handles,
				defect: source.draw(element(Arr.append(rosterDefects, "none" as const))),
				target: source.draw(element(handles))
			}
		},
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: rosterDefects satisfies ReadonlyArray<Reached<RosterDefect>>,
			check: (_, c: Case<RosterDefect>) => (s) =>
				Effect.sync(() => {
					const { handles, target } = s
					c.note(s.defect)
					if (s.defect !== "none") {
						const roster =
							s.defect === "a repeated handle"
								? [...handles, target]
								: s.defect === "an empty roster"
									? []
									: handles
						throwsRefused(
							() => admitRoster(s.name, roster, s.defect === "a third argument" ? [{}] : []),
							s.defect === "a repeated handle" ? "Refused" : "MalformedDescription"
						)
						return
					}
					const K = closed(s.name, handles, [])
					const rosterHandles: ReadonlyArray<string> = K.handles
					assert.deepEqual(rosterHandles, handles)
					const desc = relationDescOf(K, "test")
					if (desc.kind !== "closed") {
						return assert.fail("a roster's Description")
					}
					assert.deepEqual(desc.handles, handles)
					/**
					 * handle(h) is h's literal at the roster's closed id, the one typed constant of a member: a code, whose
					 * column delivers exactly h. A member off the roster is refused, and so is Compute.literal over the
					 * roster's descriptor, the JavaScript caller's path the types cannot refuse.
					 */
					const rosterId = rawClosedId(K)
					for (const h of handles) {
						const term = K.handle(h)
						assert.deepEqual(term.expr, { kind: "literal", value: h, type: descOf(rosterId) })
						assert.equal(term.sql, rosterId.sql)
						assert.deepEqual(
							term.column.kind === "code" ? term.column.handles : [],
							[h],
							"a handle's column delivers exactly its member"
						)
						throwsRefused(() => computeCore.literal(rosterId, h), "MalformedDescription")
					}
					throwsRefused(() => K.handle(`${target}Other`), "MalformedDescription")
				}),
			oracle: {
				kind: "specification",
				name: "the roster's handles in declared order, each a code of its roster"
			},
			kept: [],
			kills: []
		}
	)

/** Closed records a closed relation's rows, one per key of its roster, against its fields, and refuses every other declaration. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const closedRecordsAClosedRelationsRowsOnePerKeyOfItsRosterAgainstItsFieldsAndRefusesEveryOtherDeclaration =
	property.explore(
		(source) => {
			const handles = rosterOf(
				source.draw(
					uniqueKeys(matching(arkregex("^[A-Z][a-z]{0,6}$")), {
						min: 1,
						max: 4
					})
				)
			)
			return {
				name: source.draw(wordGen),
				handles,
				/** The handles that have a row, in declared order: a closed relation need not cover its roster. */
				held: source.draw(array(boolean, { min: 4, max: 4 })),
				payload: source.draw(uniqueArray(payloadNameGen, payloadFieldOf, { min: 0, max: 3 })),
				defect: source.draw(element(Arr.append(closedDefects, "none" as const))),
				target: source.draw(element(handles)),
				/** Whether a lawful declaration writes its first row twice, which states one fact. */
				repeat: source.draw(boolean)
			}
		},
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [
				...closedDefects,
				"no payload",
				"payload",
				"no rows",
				"a row written twice"
			] satisfies ReadonlyArray<Reached<ClosedFeature>>,
			check: (_2, c: Case<ClosedFeature>) => (s) =>
				Effect.sync(() => {
					const { handles, target } = s
					const Key = closed("Key", handles, [])
					/** A defect that needs a payload field, or a row, plants one where the draw has none. */
					const needsField =
						s.defect === "a missing field in a row" ||
						s.defect === "a mistyped value" ||
						s.defect === "a key of an open field" ||
						s.defect === "two rows of one key, other payloads"
					const drawnPayload: ReadonlyArray<{
						readonly name: string
						readonly type: PayloadType
						readonly values: ReadonlyArray<unknown>
					}> =
						needsField && s.payload.length === 0
							? [{ name: "planted", type: "flag" as const, values: [true, false, true, false] }]
							: s.defect === "two rows of one key, other payloads"
								? [
										...s.payload,
										{
											name: "planted",
											type: "flag" as const,
											values: [true, false, true, false]
										}
									]
								: s.payload
					const fields: Record<string, unknown> = {
						id: rawClosedId(Key),
						...Rec.fromEntries(Arr.map(drawnPayload, (f) => [f.name, payloadDescriptor(f.type)]))
					}
					const heldHandles = Arr.filter(handles, (_, i) => s.held[i] === true)
					const rowHandles =
						heldHandles.length === 0 && s.defect !== "none" ? [target] : heldHandles
					const rows: Array<Record<string, unknown>> = Arr.map(rowHandles, (h) => {
						const i = handles.indexOf(h)
						return {
							id: h,
							...Rec.fromEntries(Arr.map(drawnPayload, (f) => [f.name, f.values[i]]))
						}
					})
					const [first] = drawnPayload
					const firstRow = rows[0]
					let key: ReadonlyArray<string> = ["id"]
					let extra: ReadonlyArray<unknown> = []
					c.note(s.defect)
					switch (s.defect) {
						case "none":
							c.note(drawnPayload.length === 0 ? "no payload" : "payload")
							if (rows.length === 0) {
								c.note("no rows")
							}
							if (s.repeat && firstRow !== undefined) {
								rows.push({ ...firstRow })
								c.note("a row written twice")
							}
							break
						case "an extra field in a row":
							defined(firstRow)["extra"] = true
							break
						case "a missing field in a row":
							delete defined(firstRow)[defined(first).name]
							break
						case "a key off the roster":
							defined(firstRow)["id"] = `${target}Other`
							break
						case "a mistyped value":
							defined(firstRow)[defined(first).name] = mistypedValue(defined(first).type)
							break
						case "two rows of one key, other payloads":
							rows.push({
								...defined(firstRow),
								planted: defined(firstRow)["planted"] !== true
							})
							break
						case "a key of an open field":
							key = [defined(first).name]
							break
						case "a field its sequence writes":
							fields["seq"] = rawPg.bigserial
							for (const row of rows) {
								row["seq"] = 1n
							}
							break
						case "a fifth argument":
							extra = [{}]
							break
					}
					if (s.defect !== "none") {
						throwsRefused(
							() => admitClosedRelation(s.name, fields, key, rows, extra),
							s.defect === "two rows of one key, other payloads"
								? "Refused"
								: "MalformedDescription"
						)
						return
					}
					const admitted = admitClosedRelation(s.name, fields, key, rows, extra)
					const desc = admitted.desc
					assert.deepEqual(desc.key, ["id"])
					assert.deepEqual(desc.fields["id"], descOf(rawClosedId(Key)))
					const inSet = Arr.sort(rowHandles, Order.String)
					assert.deepEqual(
						Arr.map(desc.rows, (row) => row["id"]),
						inSet,
						"one fact per key, a repeat one fact, in the order of their keys"
					)
					assert.deepEqual(
						Arr.map(desc.rows, (row) => admitted.written.get(row)),
						Arr.map(inSet, (h) => rowHandles.indexOf(h)),
						"each fact's row, the first written of its key"
					)
					for (const h of rowHandles) {
						const i = handles.indexOf(h)
						const row = Option.getOrThrow(Arr.findFirst(desc.rows, (r) => r["id"] === h))
						assert.equal(row["id"], h)
						for (const f of drawnPayload) {
							const fieldDesc = descOf(payloadDescriptor(f.type))
							assert.deepEqual(desc.fields[f.name], fieldDesc)
							assert.deepEqual(
								row[f.name],
								succeeded(literalResult(fieldDesc, f.values[i], undefined))
							)
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "one row per key of the roster, against the drawn fields, each named defect refused"
			},
			kept: [],
			kills: []
		}
	)

/** Literals take their field's value rounds a real to binary32 and a numeric(p, s) to its scale, half away from zero, refusing what the column refuses, at every construction site. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 600 runs and 600 steered cases. */
export const literalsTakeTheirFieldsValueRoundsARealToBinary32AndANumericPSToItsScaleHalfAwayFromZeroRefusingWhatTheColumnRefusesAtEveryConstructionSite =
	property.explore(
		(source) => ({
			case: source.draw(caseGen),
			site: source.draw(element<Site>(["closed row", "selection", "check operand"]))
		}),
		{
			needs: {},
			budget: { runs: 600, steered: 600 },
			situations: [
				"real: rounded",
				"real: special",
				"real: overflow",
				"real: underflow",
				"real: wrong host kind",
				"double precision: kept",
				"double precision: special",
				"numeric(p, s): rounded",
				"numeric(p, s): kept",
				"numeric(p, s): overflow",
				"numeric(p, s): infinity",
				"numeric(p, s): wrong host kind",
				"numeric(p, s): special",
				"closed row",
				"selection",
				"check operand"
			] satisfies ReadonlyArray<Reached<LiteralFeature>>,
			check:
				(_, c: Case<LiteralFeature>) =>
				({ case: { field, value }, site }) =>
					Effect.sync(() => {
						const { expected, outcome } = expectedLiteral(field, value)
						c.note(`${field.kind}: ${outcome}`)
						c.note(site)
						const descriptor = literalFieldDescriptor(field)
						const host = hostValue(value)
						const result = literalResult(descOf(descriptor), host, undefined)
						if (expected.kind === "fault") {
							faulted(result, expected.fault)
						} else {
							agrees(succeeded(result), expected)
						}
						const Rated = relation("Rated", { id: uuid, value: descriptor }, ["id"], [])
						const recorded = (): LiteralDesc => {
							switch (site) {
								case "closed row": {
									const P = closed("P", ["H"], [])
									const { desc } = admitClosedRelation(
										"Rate",
										{ id: rawClosedId(P), value: descriptor },
										["id"],
										[{ id: "H", value: host }],
										[]
									)
									return defined(desc.rows[0]?.["value"])
								}
								case "selection": {
									const side = sideDescOf(
										onBuilder(
											selectBuilder(Rated, (r: { readonly value: RowTerm }) => r.value.eq(host)),
											["id"]
										)
									)
									const [predicate, ...more] = defined(side).selection.conjuncts
									if (
										more.length > 0 ||
										predicate?.kind !== "compare" ||
										predicate.right.kind !== "literal"
									) {
										return assert.fail("a selection comparing the field with a literal")
									}
									return predicate.right.value
								}
								case "check operand": {
									const desc = statementDescOf(
										checkBuilder("Bounded", Rated, (r: { readonly value: RowTerm }) =>
											r.value.le(host)
										)
									)
									if (
										desc?.kind !== "check" ||
										desc.predicate.kind !== "compare" ||
										desc.predicate.right.kind !== "literal"
									) {
										return assert.fail("a check comparing the field with a literal")
									}
									return desc.predicate.right.value
								}
							}
						}
						if (expected.kind === "fault") {
							throwsRefused(recorded, "MalformedDescription")
						} else {
							agrees(recorded(), expected)
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "binary32 rounding (Math.fround) and a numeric's scale rounded half away from zero"
			},
			kept: [],
			kills: []
		}
	)

/** Statements on names a nonempty list of distinct terms of the heading in the order written, key a side, and select a predicate. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const statementsOnNamesANonemptyListOfDistinctTermsOfTheHeadingInTheOrderWrittenKeyASideAndSelectAPredicate =
	property.explore(
		(source) => ({
			fields: source.draw(shuffled([...taskFields], { min: 1, max: [...taskFields].length })),
			planted: source.draw(element(fieldListCases)),
			handle: source.draw(element(["Automatic", "Manual"]))
		}),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: Arr.map(fieldListCases, featureOf) satisfies ReadonlyArray<
				Reached<FieldListFeature>
			>,
			check: (_, c: Case<FieldListFeature>) => (s) =>
				Effect.sync(() => {
					const planted = s.planted
					c.note(featureOf(planted))
					const selection = selectBuilder(Task, ofKind(s.handle))
					const selected: SelectionDesc = {
						conjuncts: conjunctsOf(predicateOf(ofKind(s.handle)))
					}
					switch (planted.site) {
						case "key": {
							if (planted.defect === "no side") {
								return void throwsRefused(() => keyBuilder(Task), "MalformedDescription")
							}
							const side = onBuilder(Task, s.fields)
							const k = keyBuilder(side)
							matchesObject(k, { kind: "key", side })
							const desc = statementDescOf(k)
							if (desc?.kind !== "key") {
								return assert.fail("a key statement")
							}
							return assert.deepEqual<SideDesc>(desc.side, {
								relation: "Task",
								terms: nonEmpty(fieldTerms(s.fields)),
								selection: everyFact
							})
						}
						case "on":
						case "on a selection": {
							const source = planted.site === "on" ? Task : selection
							const terms: ReadonlyArray<AnyTerm> =
								planted.defect === "an empty list"
									? []
									: planted.defect === "an undeclared field"
										? [...s.fields, "nope"]
										: planted.defect === "a repeated term"
											? [...s.fields, defined(s.fields[0])]
											: planted.defect === "pred of a field that is not natural"
												? [...s.fields, predBuilder("account")]
												: s.fields
							if (planted.defect !== "none") {
								return void throwsRefused(
									() => onBuilder(source, terms),
									planted.defect === "a repeated term" ? "Refused" : "MalformedDescription"
								)
							}
							return assert.deepEqual<SideDesc | undefined>(sideDescOf(onBuilder(source, terms)), {
								relation: "Task",
								terms: nonEmpty(fieldTerms(s.fields)),
								selection: planted.site === "on" ? everyFact : selected
							})
						}
						case "pred":
							return assert.deepEqual<SideDesc | undefined>(
								sideDescOf(onBuilder(Counted, [predBuilder("n"), "id"])),
								{
									relation: "Counted",
									terms: [
										{ kind: "pred", field: "n" },
										{ kind: "field", field: "id" }
									],
									selection: everyFact
								}
							)
						case "select":
							return void throwsRefused(
								() =>
									selectBuilder(
										Task,
										planted.defect === "no callback"
											? { kind: s.handle }
											: planted.defect === "an undeclared field"
												? (r: Row & { readonly nope: Row["id"] }) => r.eq(r.nope, s.handle)
												: () => true
									),
								"MalformedDescription"
							)
					}
				}),
			oracle: {
				kind: "specification",
				name: "the terms of the heading in the order written"
			},
			kept: [],
			kills: []
		}
	)

/** Statements contained and mirrors relate two sides built by on, of one width. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const statementsContainedAndMirrorsRelateTwoSidesBuiltByOnOfOneWidth = property.explore(
	(source) => ({
		statement: source.draw(element<SideStatement>(["contained", "mirrors"])),
		left: source.draw(int(1, 3)),
		right: source.draw(int(1, 3)),
		bare: source.draw(
			weighted<"none" | "left" | "right">([
				[2, constant("none")],
				[1, constant("left")],
				[1, constant("right")]
			])
		)
	}),
	{
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: Arr.flatMap(["contained", "mirrors"] as const, (st) =>
			Arr.map(
				["related", "widths differ", "a bare relation"] as const,
				(o) => `${st}: ${o}` as const
			)
		) satisfies ReadonlyArray<
			Reached<`${SideStatement}: ${"related" | "widths differ" | "a bare relation"}`>
		>,
		check:
			(_, c: Case<`${SideStatement}: ${"related" | "widths differ" | "a bare relation"}`>) => (s) =>
				Effect.sync(() => {
					const left = onBuilder(Task, taskFields.slice(0, s.left))
					const right = onBuilder(Triple, tripleFields.slice(0, s.right))
					const l = s.bare === "left" ? Task : left
					const r = s.bare === "right" ? Triple : right
					const build = () =>
						s.statement === "contained" ? containedBuilder(l, r) : mirrorsBuilder(l, r)
					const related = s.bare === "none" && s.left === s.right
					c.note(
						`${s.statement}: ${related ? "related" : s.bare === "none" ? "widths differ" : "a bare relation"}`
					)
					if (!related) {
						return void throwsRefused(build, s.bare === "none" ? "Refused" : "MalformedDescription")
					}
					const built = build()
					const [l0, r0] = [defined(sideDescOf(left)), defined(sideDescOf(right))]
					/** mirrors is sugar: no statement of its own, the expansion of its two containments. */
					const stated = (st: StatementDesc | undefined) =>
						st?.kind === "contained"
							? [st.left, st.right]
							: assert.fail(`a ${s.statement} statement`)
					if (s.statement === "mirrors") {
						assert.equal(statementDescOf(built), undefined, "mirrors states no statement itself")
						return assert.deepEqual(Arr.map(defined(expansionDescOf(built)).statements, stated), [
							[l0, r0],
							[r0, l0]
						])
					}
					const desc = statementDescOf(built)
					assert.equal(desc?.kind, s.statement)
					assert.deepEqual(stated(desc), [l0, r0])
				}),
		oracle: { kind: "specification", name: "two sides built by on, of one width" },
		kept: [],
		kills: []
	}
)

/** Statements check records the row predicate over its own row, literals adopting the field's type, terms admitted by identity. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const statementsCheckRecordsTheRowPredicateOverItsOwnRowLiteralsAdoptingTheFieldsTypeTermsAdmittedByIdentity =
	property.explore(
		(source) => ({
			predicate: source.draw(predicateGen(2)),
			defect: source.draw(
				element(Arr.append(Arr.append(checkDefects, "none" as const), "none" as const))
			)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [...checkDefects, "a sum", "an untyped sum"] satisfies ReadonlyArray<
				Reached<CheckDefect | "a sum" | "an untyped sum">
			>,
			check:
				(_, c: Case<CheckDefect | "a sum" | "an untyped sum">) =>
				({ predicate, defect }) =>
					Effect.sync(() => {
						c.note(defect)
						const build = () =>
							checkBuilder("Bounded", Election, (e: Row) =>
								defect === "a callback returning no predicate"
									? true
									: defect === "none"
										? built(e, predicate)
										: e.and(built(e, predicate), plantedConjunct(e, defect))
							)
						if (defect !== "none") {
							return void throwsRefused(
								build,
								defect === "a parameter" ? "Refused" : "MalformedDescription"
							)
						}
						const sums = operandsOf(predicate)
						if (Arr.some(sums, (o) => o.kind === "sum" && o.typed)) {
							c.note("a sum")
						}
						if (Arr.some(sums, (o) => o.kind === "sum" && !o.typed)) {
							c.note("an untyped sum")
						}
						const value = build()
						matchesObject(value, { kind: "check", name: "Bounded", relation: Election })
						const desc = statementDescOf(value)
						if (desc?.kind !== "check") {
							return assert.fail("a check statement")
						}
						assert.deepEqual(desc, {
							...desc,
							name: "Bounded",
							relation: "Election",
							predicate: recordedExpr(predicate)
						})
					}),
			oracle: {
				kind: "specification",
				name: "the row predicate over its own row, literals of the field's type"
			},
			kept: [],
			kills: []
		}
	)

/** Alternatives is one statement of its armed handles in roster order, expanding to each arm's containment and each handle's reverse. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const alternativesIsOneStatementOfItsArmedHandlesInRosterOrderExpandingToEachArmsContainmentAndEachHandlesReverse =
	property.explore(
		(source) => ({
			handles: source.draw(
				uniqueKeys(matching(arkregex("^[A-Z][a-z]{0,6}$")), {
					min: 1,
					max: 4
				})
			),
			armed: source.draw(array(boolean, { min: 4, max: 4 })),
			arming: source.draw(array(boolean, { min: 4, max: 4 })),
			wide: source.draw(boolean),
			parentKey: source.draw(boolean),
			defect: source.draw(element(Arr.append(alternativesDefects, "none" as const))),
			at: source.draw(pickGen)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [
				...alternativesDefects,
				"a Key as the parent",
				"a Key as an arm",
				"an unarmed handle",
				"a two-field key"
			] satisfies ReadonlyArray<Reached<AlternativesFeature>>,
			check: (_, c: Case<AlternativesFeature>) => (s) =>
				Effect.sync(() => {
					c.note(s.defect)
					const Mode = closed("Mode", rosterOf(s.handles), [])
					const Job = relation(
						"Job",
						{ id: uuid, mode: rawClosedId(Mode), other: uuid, alien: rawClosedId(Alien) },
						["id"],
						[]
					)
					/** The parent's key: Job's primary key, a one-field Key, or a two-field Key. */
					const parentFields = s.wide ? ["id", "other"] : s.parentKey ? ["other"] : ["id"]
					const parent = s.wide || s.parentKey ? keyBuilder(onBuilder(Job, parentFields)) : Job
					if (s.wide) {
						c.note("a two-field key")
					} else if (s.parentKey) {
						c.note("a Key as the parent")
					}
					/** The armed handles, at least one: the first is armed when the draw arms none. */
					const drawnArmed = whereIndex(s.handles, (i) => s.armed[i] === true)
					const armedHandles = drawnArmed.length > 0 ? drawnArmed : s.handles.slice(0, 1)
					if (armedHandles.length < s.handles.length) {
						c.note("an unarmed handle")
					}
					const target = defined(armedHandles[pickIndex(s.at, armedHandles.length)])
					const arms: Record<string, unknown> = {}
					const armKeys: Record<
						string,
						{ readonly relation: string; readonly fields: ReadonlyArray<string> }
					> = {}
					for (const h of armedHandles) {
						const i = s.handles.indexOf(h)
						const Arm = relation(`Arm${i}`, { job: uuid, extra: uuid }, ["job"], [])
						const unlike = s.defect === "an arm keyed unlike the parent" && h === target
						const two = s.wide !== unlike
						const viaKey = two || s.arming[i] === true
						const fields = two ? ["job", "extra"] : viaKey ? ["extra"] : ["job"]
						if (viaKey && !two) {
							c.note("a Key as an arm")
						}
						arms[h] = viaKey ? keyBuilder(onBuilder(Arm, fields)) : Arm
						armKeys[h] = { relation: `Arm${i}`, fields }
					}
					if (s.defect === "an arm off the roster") {
						arms[`${target}Off`] = arms[target]
					}
					if (s.defect === "the parent as an arm") {
						arms[target] = parent
					}
					const discriminator =
						s.defect === "a discriminator of another type"
							? "other"
							: s.defect === "a discriminator of another roster"
								? "alien"
								: "mode"
					const armMap = s.defect === "no arms" ? {} : arms
					const build = () => alternativesBuilder(parent, discriminator, Mode, armMap)
					if (s.defect !== "none") {
						return void throwsRefused(build, alternativesTags[s.defect])
					}
					const law = build()
					assert.equal(Object.isFrozen(law), true)
					matchesObject(law, {
						kind: "alternatives",
						parent,
						discriminator: "mode",
						roster: Mode
					})
					assert.deepEqual(law.arms, arms)
					/** Each armed handle in roster order, with its arm's key side. */
					const armed = Arr.flatMap(s.handles, (h) => {
						const arm = armKeys[h]
						return arm === undefined
							? []
							: [
									{
										handle: h,
										arm: {
											relation: arm.relation,
											terms: fieldTerms(arm.fields),
											selection: everyFact
										}
									}
								]
					})
					const desc = statementDescOf(law)
					if (desc?.kind !== "alternatives") {
						return assert.fail("an alternatives statement")
					}
					matchesObject(desc, {
						kind: "alternatives",
						parent: { relation: "Job", terms: fieldTerms(parentFields), selection: everyFact },
						discriminator: "mode",
						roster: "Mode",
						arms: armed
					})
					/**
					 * No head containment: the roster's domain types the discriminator. Each arm, its own relation here, is
					 * contained in its handle's parents, selected by their discriminator; then each handle's parents are
					 * contained in its arm (ir/desc.ts expandAlternatives).
					 */
					const selected = (h: string) => ({
						relation: "Job",
						terms: fieldTerms(parentFields),
						selection: {
							conjuncts: [
								{
									kind: "compare" as const,
									op: "eq" as const,
									left: { kind: "field" as const, field: "mode" },
									right: { kind: "literal" as const, value: h }
								}
							]
						}
					})
					matchesObject(expandAlternatives(desc), [
						...Arr.map(armed, (a) => ({
							kind: "contained" as const,
							left: a.arm,
							right: selected(a.handle)
						})),
						...Arr.map(armed, (a) => ({
							kind: "contained" as const,
							left: selected(a.handle),
							right: a.arm
						}))
					])
				}),
			oracle: {
				kind: "specification",
				name: "each arm's containment and each handle's reverse, in roster order"
			},
			kept: [],
			kills: []
		}
	)

/** Schema and schema.extend records each relation of its list under the name it carries, first declared first, and statements in order, expanding mirrors in place, and refuses a malformed declaration where it stands. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const schemaAndSchemaExtendRecordsEachRelationOfItsListUnderTheNameItCarriesFirstDeclaredFirstAndStatementsInOrderExpandingMirrorsInPlaceAndRefusesAMalformedDeclarationWhereItStands =
	property.explore(
		(source) => {
			const statements = source.draw(
				shuffled([0, 1, 2, 3], { min: 0, max: statementValues.length })
			)
			const listed = [
				...Arr.flatMap(statements, (i) => defined(statementValues[i], "a statement").over),
				...source.draw(nonEmptyGen(element(entryNames), 2))
			]
			return {
				entries: source.draw(shuffled(listed, { min: listed.length, max: listed.length })),
				statements,
				defect: source.draw(element(Arr.append(schemaDefects, "none" as const)))
			}
		},
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: [...schemaDefects, "mirrors expanded"] satisfies ReadonlyArray<
				Reached<SchemaDefect | "mirrors expanded">
			>,
			check: (_, c: Case<SchemaDefect | "mirrors expanded">) => (s) =>
				Effect.sync(() => {
					c.note(s.defect)
					const relations = Arr.map(s.entries, (e) => entryValues[e])
					const statements = Arr.map(
						s.statements,
						(i) => defined(statementValues[i], "a statement").statement
					)
					const names = distinct(s.entries)
					/** The schema's relations by the names they carry, as S.relations holds them. */
					const byName = Rec.fromEntries(Arr.map(names, (n) => [n, entryValues[n]] as const))
					/**
					 * A planted defect is refused by schema(...)'s admission core as MalformedDescription at the place it
					 * stands: the call's own label, or the relation or statement at its position in its list.
					 */
					const refusedAt = (label: string, thunk: () => unknown): void =>
						assert.deepEqual(placeOf(refusalLoc(throwsRefused(thunk, "MalformedDescription"))), {
							label,
							path: []
						})
					switch (s.defect) {
						case "relations that are no list":
							return refusedAt("schema Work", () => admitSchema("Work", byName, statements, []))
						case "a list as a statement":
							return refusedAt(`schema Work statement ${statements.length}`, () =>
								admitSchema(
									"Work",
									relations,
									[...statements, [defined(statementValues[2], "a statement").statement]],
									[]
								)
							)
						case "a statement no builder made":
							return refusedAt(`schema Work statement ${statements.length}`, () =>
								admitSchema("Work", relations, [...statements, { kind: "key" }], [])
							)
						case "a derived relation":
							return refusedAt(`schema Work relation ${relations.length}`, () =>
								admitSchema("Work", [...relations, D], statements, [])
							)
						case "statements that are no list":
							return refusedAt("schema Work", () =>
								admitSchema("Work", relations, "statements", [])
							)
						case "none":
							break
					}
					const W = schema("Work", relations, statements, [])
					const desc = defined(schemaDescOf(W))
					assert.deepEqual(
						Arr.map(desc.relations, (r) => r.name),
						names
					)
					const expanded = Arr.flatMap(statements, (st): ReadonlyArray<StatementDesc> => {
						const expansion = expansionDescOf(st)
						return expansion === undefined ? [defined(statementDescOf(st))] : expansion.statements
					})
					if (expanded.length > statements.length) {
						c.note("mirrors expanded")
					}
					assert.deepEqual(desc.statements, expanded)
					matchesObject(W, { name: "Work", relations: byName, statements })
					assert.equal("extends" in W ? W.extends : "no base member", undefined)
				}),
			oracle: {
				kind: "specification",
				name: "each relation under the name it carries, first declared first, statements in order, mirrors expanded in place"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/schema.ts",
					original: "\tif (!isList(relations)) {",
					replacement:
						'\tif (!isList(relations)) {\n\t\tif (typeof relations === "object" && relations !== null) {\n\t\t\treturn Object.values(relations)\n\t\t}',
					why: "schema() reads a record's values as its list of relations (schema/schema.ts relationValues), a shim for the old form; relations that are no list are admitted."
				}
			]
		}
	)

/** Schema and schema.extend extends under its own name and computes derived levels from what definitions read. Its budget is its suite's before it was a property (test/unit/schema/constructors.test.ts at 4ca3036a): 300 runs and 900 steered cases. */
export const schemaAndSchemaExtendExtendsUnderItsOwnNameAndComputesDerivedLevelsFromWhatDefinitionsRead =
	property.explore(
		(source) => ({
			levels: source.draw(
				nonEmptyGen(
					nonEmptyGen(
						(inner) => ({
							reads: inner.draw(nonEmptyGen(pickGen, 1)),
							prefix: inner.draw(element(["A", "M", "Z"]))
						}),
						1
					),
					2
				)
			),
			defect: source.draw(
				element(Arr.append(Arr.append(levelDefects, "none" as const), "none" as const))
			)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 900 },
			situations: [
				...levelDefects,
				"level 2",
				"level 3",
				"two reads",
				"a deeper read named first"
			] satisfies ReadonlyArray<
				Reached<LevelDefect | "level 2" | "level 3" | "two reads" | "a deeper read named first">
			>,
			check:
				(
					_,
					c: Case<LevelDefect | "level 2" | "level 3" | "two reads" | "a deeper read named first">
				) =>
				(s) =>
					Effect.sync(() => {
						c.note(s.defect)
						interface Declared {
							readonly name: string
							readonly value: AnyRelation | AnyDerived
							/** 0 for a base relation. */
							readonly derivedLevel: number
						}
						const tower = () => {
							const base = schema("Edu", [Kind, Task], [], [])
							const below: Array<Declared> = [{ name: "Task", value: Task, derivedLevel: 0 }]
							const chain: Array<AnySchema> = [base]
							const expected: Array<{
								readonly name: string
								readonly level: number
								readonly schemaLevel: number
								readonly reads: ReadonlyArray<string>
							}> = []
							let current: AnySchema = base
							for (const [k, level] of s.levels.entries()) {
								const declared: Array<Declared> = []
								const record: Record<string, AnyDerived> = {}
								for (const [j, view] of level.entries()) {
									const reads = distinct(
										Arr.map(view.reads, (p) => defined(below[pickIndex(p, below.length)]))
									)
									/**
									 * The prefix varies where a view sorts by name among the relations a later definition reads.
									 */
									const name = `${view.prefix}View${k + 1}x${j}`
									const value = materializedDerived(
										name,
										idsOf(current, [
											defined(reads[0]).value,
											...Arr.map(reads.slice(1), (r) => r.value)
										]),
										[]
									)
									const derivedLevel = maxOf(
										Arr.map(reads, (r) => r.derivedLevel + 1),
										Number.NEGATIVE_INFINITY
									)
									if (reads.length > 1) {
										c.note("two reads")
									}
									const byName = Arr.sort(
										Arr.filter(reads, (r) => r.derivedLevel > 0),
										Order.mapInput(Order.String, (r: { readonly name: string }) => r.name)
									)
									const lastByName = byName[byName.length - 1]
									if (lastByName !== undefined && lastByName.derivedLevel + 1 < derivedLevel) {
										c.note("a deeper read named first")
									}
									if (derivedLevel === 2) {
										c.note("level 2")
									}
									if (derivedLevel === 3) {
										c.note("level 3")
									}
									declared.push({ name, value, derivedLevel })
									record[name] = value
									expected.push({
										name,
										level: derivedLevel,
										schemaLevel: k + 1,
										reads: Arr.sort(
											Arr.map(reads, (r) => r.name),
											Order.String
										)
									})
								}
								if (k === s.levels.length - 1) {
									const first = defined(declared[0])
									switch (s.defect) {
										case "a read of its own level":
											record["OwnLevel"] = materializedDerived(
												"OwnLevel",
												idsOf(schema.extend(current, "Probe", [first.value], [], []), [
													first.value
												]),
												[]
											)
											break
										case "a parameter":
											record["ByAccount"] = materializedDerived(
												"ByAccount",
												queryOver(current).rule((r: RuleValue) => {
													const { id } = varsOver(Task, "task")
													return r
														.match(Task, { id, account: r.param("account", uuid) })
														.find({ id })
												}),
												[]
											)
											break
										case "a definition that is no query":
											admitDerived("Bad", {}, "materialized", [])
											break
										case "none":
											break
									}
								}
								current = schema.extend(current, `Level${chain.length}`, Rec.values(record), [], [])
								chain.push(current)
								appendAll(below, declared)
							}
							return { current, chain, expected }
						}
						if (s.defect !== "none") {
							return void throwsRefused(tower, "MalformedDescription")
						}
						const { current, chain, expected } = tower()
						for (const [k, value] of chain.entries()) {
							const desc = defined(schemaDescOf(value))
							assert.equal(desc.name, k === 0 ? "Edu" : `Level${k}`)
							assert.equal(
								"extends" in value ? value.extends : "no base member",
								k === 0 ? undefined : chain[k - 1]
							)
							if (k > 0) {
								matchesObject(
									desc.relations,
									Arr.map(
										Arr.filter(expected, (e) => e.schemaLevel === k),
										(e) => ({ kind: "derived" as const, name: e.name, level: e.level })
									)
								)
							}
						}
						const owned = succeeded(own(defined(schemaDescOf(current))))
						for (const e of expected) {
							const r = defined(owned.relations[e.name])
							if (r.kind !== "derived") {
								return assert.fail(`${e.name} is a derived relation`)
							}
							assert.deepEqual([r.level, r.desc.level, r.reads], [e.schemaLevel, e.level, e.reads])
						}
					}),
			oracle: {
				kind: "specification",
				name: "the levels computed from what each definition reads"
			},
			kept: [],
			kills: []
		}
	)
