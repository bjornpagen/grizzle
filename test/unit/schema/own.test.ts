/**
 * Ownership at the schema door (schema/own.ts): what a schema owns, and what it refuses, each by its documented reason.
 *
 * - Fingerprint: the fingerprint is of canonical content: order, repeats and locations drop out, meaning does not, and
 *   the canonical description owns to it. Oracle: the fingerprint's invariance, a metamorphic relation.
 * - Conflicts: a name claimed twice with conflicting meaning is refused, and the same meaning twice owns as one.
 * - Handles: every handle written against a closedId field, at any contract depth, is checked against its roster; a
 *   handle longer than a name's 63 bytes is refused, built or decoded. Oracles: the roster's own handles; NAMEDATALEN
 *   - 1, restated.
 * - Statements over a derived relation: a key, a check, a containment either way and mirrors own over one, and
 *   mutable and race are refused, from a description or the builders.
 * - Structure: a description naming what no level declares, or breaking a structural rule, is refused by its reason.
 *   Names no fixture declares are built so, ending in a digit, never drawn and filtered.
 *
 * Features: as each search names them.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, int, shuffled, weighted } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { regex as arkregex } from "arkregex"
import { Array as Arr, Effect, Option, Record, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"

import { assert, defined } from "@bjornpagen/testing/assert"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { own } from "#compiler/schema/own.ts"
import {
	closedBuilder as closed,
	closedRelation,
	derivedBuilder,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	containedBuilder,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	raceBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	contained,
	eq,
	field,
	key,
	literal,
	on,
	onWhere,
	pred,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import {
	rawClosedId,
	rawContract,
	rawPg,
	rawSpan,
	type Row
} from "#test/support/unit/schema/support.ts"
import {
	Account,
	answers,
	atLeast,
	baseOf,
	baseSide,
	Claim,
	claimsOf,
	type Conflict,
	conflicts,
	decoded,
	definition,
	derivedSide,
	type DerivedStatementKind,
	builtDescOf,
	type FingerprintFeature,
	gradeFact,
	gradeOrder,
	entity,
	type HandleSite,
	handleSites,
	hasOrder,
	Kind,
	Level,
	Limits,
	limitsPredicate,
	limitsPredicateGen,
	type LimitsRow,
	type MeaningChange,
	optional,
	ownValue,
	Pool,
	relationPlaces,
	Reports,
	rotated,
	ruled,
	space,
	type StatementForm,
	statementForms,
	type Structure,
	structures,
	Task,
	TaskIds,
	undeclaredWordGen,
	withStatements,
	Work,
	wrapped
} from "#test/unit/schema/own.fixtures.ts"

/** The owned product fingerprints canonical content: order, repeats and locations drop out, meaning does not, and the canonical description owns to it. Its budget is its suite's before it was a property (test/unit/schema/own.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const theOwnedProductFingerprintsCanonicalContentOrderRepeatsAndLocationsDropOutMeaningDoesNotAndTheCanonicalDescriptionOwnsToIt =
	property.explore(
		(source) => ({
			relationOrder: source.draw(
				shuffled(relationPlaces, { min: relationPlaces.length, max: relationPlaces.length })
			),
			statements: source.draw(shuffled([0, 1, 2], { min: 0, max: [0, 1, 2].length })),
			rows: source.draw(shuffled(gradeOrder, { min: gradeOrder.length, max: gradeOrder.length })),
			rewriteOrder: source.draw(int(0, 4)),
			repeats: source.draw(boolean),
			predicate: source.draw(limitsPredicateGen(2)),
			extended: source.draw(boolean),
			change: source.draw(
				element<MeaningChange>(["none", "roster order", "check predicate", "closed row"])
			)
		}),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: [
				"roster order",
				"check predicate",
				"closed row",
				"reordered check operands",
				"reordered closed rows",
				"repeated statements",
				"an extension"
			] satisfies ReadonlyArray<Reached<FingerprintFeature>>,
			check: (_, c: Case<FingerprintFeature>) => (s) =>
				Effect.sync(() => {
					const relations = (
						roster: AnyClosed,
						rewrite: boolean,
						changed: boolean
					): ReadonlyArray<readonly [string, AnyRelation | AnyClosed]> => [
						["Kind", roster],
						["Level", Level],
						[
							"Grade",
							closedRelation(
								"Grade",
								{ kind: rawClosedId(roster), level: rawClosedId(Level), weight: rawPg.integer },
								["kind", "level"],
								Arr.map(rewrite ? (s.repeats ? [...s.rows, ...s.rows] : s.rows) : gradeOrder, (i) =>
									gradeFact(i, changed && i === 0)
								),
								[]
							)
						],
						["Account", Account],
						["Task", Task],
						["Limits", Limits]
					]
					const bounded = (rewrite: boolean, change: boolean) =>
						checkBuilder("Bounded", Limits, (r: LimitsRow) =>
							change
								? r.and([limitsPredicate(r, s.predicate, rewrite), r.ge(r.limit, -6n)])
								: limitsPredicate(r, s.predicate, rewrite)
						)
					const declare = (form: "written" | "rewritten" | "changed") => {
						const rewrite = form === "rewritten"
						const changed = form === "changed"
						const roster =
							changed && s.change === "roster order"
								? closed("Kind", ["Manual", "Automatic"], "ordered", [])
								: Kind
						const declared = relations(roster, rewrite, changed && s.change === "closed row")
						const record = Record.fromEntries(
							rewrite ? Arr.map(s.relationOrder, (i) => defined(declared[i])) : declared
						)
						const chosen = Arr.map(s.statements, (i) => defined(optional[i]))
						const statements = [
							...(rewrite ? rotated(chosen, s.rewriteOrder) : chosen),
							entity,
							bounded(rewrite, changed && s.change === "check predicate")
						]
						const all =
							rewrite && s.repeats
								? [...statements, ...statements, bounded(false, false)]
								: statements
						const root = schema(
							"Work",
							Record.values(record),
							rewrite ? Arr.reverse([...all]) : all,
							[]
						)
						if (!s.extended) {
							return root
						}
						const Ids = derivedBuilder(
							"TaskIds",
							queryOver(root).rule((r: RuleValue) => {
								const { id } = varsOver(Task, "task")
								return r.match(Task, { id }).find({ id })
							}),
							[]
						)
						return schema.extend([root], "Above", [Ids], [], [])
					}
					if (s.extended) {
						c.note("an extension")
					}
					if (s.repeats) {
						c.note("repeated statements")
					}
					if (hasOrder(s.predicate)) {
						c.note("reordered check operands")
					}
					if (Arr.some(s.rows, (row, i) => row !== gradeOrder[i])) {
						c.note("reordered closed rows")
					}
					/** The rewritten form owned from its description, relations and statements of every level reversed. */
					const reversed = (d: SchemaDesc): SchemaDesc => ({
						...d,
						relations: Arr.reverse(
							Arr.map(d.relations, (r) =>
								r.kind === "closedRelation" ? { ...r, rows: Arr.reverse([...r.rows]) } : r
							)
						),
						statements: Arr.reverse([...d.statements]),
						bases: d.bases[0] === undefined ? [] : [reversed(d.bases[0])]
					})
					const written = succeeded(ownValue(declare("written")))
					const rewritten = succeeded(ownValue(reversed(builtDescOf(declare("rewritten")))))
					assert.equal(rewritten.fingerprint, written.fingerprint)
					assert.equal(succeeded(ownValue(declare("rewritten"))).fingerprint, written.fingerprint)
					assert.equal(rewritten.statements.length, written.statements.length)
					assert.equal(Object.isFrozen(written.desc), true)
					assert.equal(succeeded(own(written.desc)).fingerprint, written.fingerprint)
					if (s.change === "none") {
						return
					}
					c.note(s.change)
					assert.notEqual(succeeded(ownValue(declare("changed"))).fingerprint, written.fingerprint)
				}),
			oracle: {
				kind: "universal",
				name: "the fingerprint is invariant under order, repeats and locations, and moves with meaning"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/own.ts",
					original: "\t\t\t\t.toSorted((a, b) => compareStrings(a.identity, b.identity))\n",
					replacement: "",
					why: "Statements kept in the order written (schema/own.ts canonicalDesc), so reordering moves the fingerprint; the fingerprint property fails."
				}
			]
		}
	)

/**
 * Conflicting declarations refuses a name claimed twice with conflicting meaning, and owns the same meaning twice as one
 * declaration. The claimed contract's name is a word no fixture declares (undeclaredWordGen), so the only claims of it
 * are the case's two: a word that is a declared name, the tests' Id among them, is claimed by the fixture's own fields
 * too, with another meaning, a DuplicateIdentity the agreeing case does not state. Its budget is its suite's before it
 * was a property (test/unit/schema/own.test.ts at 4ca3036a): 300 runs and 300 steered cases.
 */
export const conflictingDeclarationsRefusesANameClaimedTwiceWithConflictingMeaningAndOwnsTheSameMeaningTwiceAsOneDeclaration =
	property.explore(
		(source) => ({
			conflict: source.draw(element(conflicts)),
			agree: source.draw(boolean),
			name: source.draw(undeclaredWordGen),
			n: source.draw(bigint(0n, 9n)),
			swapped: source.draw(boolean)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: Arr.flatMap(conflicts, (k) => [
				`${k}: refused` as const,
				`${k}: one declaration` as const
			]) satisfies ReadonlyArray<Reached<`${Conflict}: ${"refused" | "one declaration"}`>>,
			check: (_, c: Case<`${Conflict}: ${"refused" | "one declaration"}`>) => (s) =>
				Effect.sync(() => {
					c.note(`${s.conflict}: ${s.agree ? "one declaration" : "refused"}`)
					const owned = (() => {
						switch (s.conflict) {
							case "a contract name over another base":
							case "a contract name with another predicate": {
								const first = rawContract(s.name, rawPg.bigint, atLeast(s.n))
								const second: FieldBase = s.agree
									? s.swapped
										? rawSpan(rawContract(s.name, rawPg.bigint, atLeast(s.n)))
										: rawContract(s.name, rawPg.bigint, atLeast(s.n))
									: s.conflict === "a contract name over another base"
										? rawContract(s.name, rawPg.integer, atLeast(s.n))
										: rawContract(s.name, rawPg.bigint, atLeast(s.n + 1n))
								const A = relation("A", { id: Id, amount: first }, ["id"], [])
								const B = relation("B", { id: Id, amount: second }, ["id"], [])
								return ownValue(schema("Pay", [A, B], [], []))
							}
							case "a relation name across levels":
								return Result.flatMap(
									catchCompileError(() =>
										schema.extend(
											[Work],
											"Above",
											[s.agree ? Task : relation("Task", { id: Id }, ["id"], [])],
											[],
											[]
										)
									),
									ownValue
								)
						}
					})()
					if (s.agree) {
						succeeded(owned)
					} else {
						refused(owned, "DuplicateIdentity")
					}
				}),
			oracle: {
				kind: "specification",
				name: "one declaration per meaning, a conflicting claim refused"
			},
			kept: [],
			kills: [
				{
					file: "packages/text/src/regex/ir.ts",
					original: '\t\tif (item.kind === "never") {',
					replacement: '\t\tif (item.kind !== "never") {',
					why: "Operator mutant c954b1fc63 at packages/text/src/regex/ir.ts:241 in seq: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)

/** Closed relations checks every handle written against a closedId field, at any contract depth, against its roster. Its budget is its suite's before it was a property (test/unit/schema/own.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const closedRelationsChecksEveryHandleWrittenAgainstAClosedIdFieldAtAnyContractDepthAgainstItsRoster =
	property.explore(
		(source) => ({
			site: source.draw(element(handleSites)),
			depth: source.draw(int(0, 3)),
			handle: source.draw(
				weighted([
					[1, element(["Automatic", "Manual"])],
					[1, undeclaredWordGen]
				])
			)
		}),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: [
				...Arr.flatMap(handleSites, (site) => [
					`${site}: on the roster` as const,
					`${site}: off the roster` as const
				]),
				"nested contracts"
			] satisfies ReadonlyArray<
				Reached<`${HandleSite}: ${"on the roster" | "off the roster"}` | "nested contracts">
			>,
			check:
				(_, c: Case<`${HandleSite}: ${"on the roster" | "off the roster"}` | "nested contracts">) =>
				(s) =>
					Effect.sync(() => {
						const onRoster = s.handle === "Automatic" || s.handle === "Manual"
						c.note(`${s.site}: ${onRoster ? "on the roster" : "off the roster"}`)
						if (s.depth > 1) {
							c.note("nested contracts")
						}
						const grade = wrapped(s.depth)
						/** Graded relates each Level to a grade, a closed relation keyed by the roster Level. */
						const Level = closed("Level", ["Low", "High"], "ordered", [])
						const gradedFields = { id: rawClosedId(Level), grade }
						const Graded = closedRelation(
							"Graded",
							gradedFields,
							["id"],
							[
								{ id: "Low", grade: "Automatic" },
								{ id: "High", grade: "Manual" }
							],
							[]
						)
						const Rated = relation("Rated", { id: Id, grade }, ["id"], [])
						const valid = builtDescOf(schema("W", [Kind, Level, Graded, Rated, Task], [], []))
						const build = (): unknown => {
							switch (s.site) {
								case "a built row":
									return closedRelation(
										"Graded",
										gradedFields,
										["id"],
										[{ id: "Low", grade: s.handle }],
										[]
									)
								case "a built selection":
									return selectBuilder(Rated, (r: Row & { readonly grade: Row["id"] }) =>
										r.eq(r.grade, s.handle)
									)
								case "a built check literal":
									return checkBuilder("Graded", Rated, (r: Row & { readonly grade: Row["id"] }) =>
										r.eq(r.grade, s.handle)
									)
								case "a decoded row":
								case "a decoded selection":
								case "a decoded check literal":
									return undefined
							}
						}
						const result = (() => {
							switch (s.site) {
								case "a decoded row":
									return decoded({
										...valid,
										relations: Arr.map(valid.relations, (r) =>
											r.kind === "closedRelation" && r.name === "Graded"
												? {
														...r,
														rows: [
															{ id: "Low", grade: "Automatic" },
															{ id: "High", grade: s.handle }
														]
													}
												: r
										)
									})
								case "a decoded selection":
									return decoded({
										...valid,
										statements: [
											contained(
												onWhere("Rated", ["id"], eq(field("grade"), literal(s.handle))),
												on("Task", ["id"])
											)
										]
									})
								case "a decoded check literal":
									return decoded({
										...valid,
										statements: [
											{
												kind: "check",
												name: "Graded",
												relation: "Rated",
												predicate: {
													kind: "compare",
													op: "eq",
													left: { kind: "field", field: "grade" },
													right: { kind: "literal", value: s.handle }
												}
											}
										]
									})
								case "a built row":
								case "a built selection":
								case "a built check literal":
									return undefined
							}
						})()
						if (result === undefined) {
							if (onRoster) {
								build()
							} else {
								throwsRefused(build, "MalformedDescription")
							}
						} else if (onRoster) {
							succeeded(result)
						} else {
							refused(result, "MalformedDescription")
						}
					}),
			oracle: { kind: "specification", name: "the roster's own handles" },
			kept: [],
			kills: []
		}
	)

/** Closed relations refuses a handle longer than a name's 63 bytes, the most a roster's names constant holds, built or decoded. Its budget is its suite's before it was a property (test/unit/schema/own.test.ts at 4ca3036a): 200 runs and 200 steered cases. */
export const closedRelationsRefusesAHandleLongerThanANames63BytesTheMostARostersNamesConstantHoldsBuiltOrDecoded =
	property.explore(
		(source) => ({
			accented: source.draw(int(0, 31)),
			delta: source.draw(int(-3, 3)),
			decoded: source.draw(boolean)
		}),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: [
				"built within",
				"built above",
				"decoded within",
				"decoded above",
				"at 63 bytes",
				"at 64 bytes"
			] satisfies ReadonlyArray<
				Reached<`${"built" | "decoded"} ${"within" | "above"}` | "at 63 bytes" | "at 64 bytes">
			>,
			check:
				(
					_,
					c: Case<`${"built" | "decoded"} ${"within" | "above"}` | "at 63 bytes" | "at 64 bytes">
				) =>
				(s) =>
					Effect.sync(() => {
						/** One capital, then ASCII letters filling the handle to 63 + delta bytes around the two-byte ones. */
						const ascii = Math.max(0, 62 + s.delta - 2 * s.accented)
						const handle = `H${Str.repeat(ascii)("h")}${Str.repeat(s.accented)("é")}`
						const bytes = 1 + ascii + 2 * s.accented
						const within = bytes <= 63
						c.note(`${s.decoded ? "decoded" : "built"} ${within ? "within" : "above"}`)
						if (bytes === 63) {
							c.note("at 63 bytes")
						}
						if (bytes === 64) {
							c.note("at 64 bytes")
						}
						if (!s.decoded) {
							const build = () => closed("Long", [handle], "ordered", [])
							if (within) {
								succeeded(ownValue(schema("W", [build()], [], [])))
							} else {
								throwsRefused(build, "MalformedDescription")
							}
							return
						}
						const d = builtDescOf(schema("W", [Kind], [], []))
						const owned = ownValue({
							...d,
							relations: Arr.map(d.relations, (r) =>
								r.kind === "closed" ? { ...r, handles: [handle] } : r
							)
						})
						if (within) {
							succeeded(owned)
						} else {
							refused(owned, "MalformedDescription")
						}
					}),
			oracle: { kind: "specification", name: "NAMEDATALEN - 1, 63 bytes, restated" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/query/build/rule.ts",
					original: "\t\t\tif (prior !== undefined && prior !== ref.scope) {",
					replacement: "\t\t\tif (prior === undefined && prior !== ref.scope) {",
					why: "Operator mutant 02fcc4cf7e at packages/engine/src/query/build/rule.ts:294 in finishRule: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)

/** Statements over a derived relation owns a key, check, containment either way and mirrors over a derived relation, and refuses mutable and race over one, from a description or the builders. */
export const statementsOverADerivedRelationOwnsAKeyCheckContainmentEitherWayAndMirrorsOverADerivedRelationAndRefusesMutableAndRaceOverOneFromADescriptionOrTheBuilders =
	property.exhaust(finite(space), {
		needs: {},
		situations: Arr.map(
			statementForms,
			(l) => `${l.kind} ${l.form}` as const
		) satisfies ReadonlyArray<Reached<`${DerivedStatementKind} ${StatementForm["form"]}`>>,
		check:
			(_, c: Case<`${DerivedStatementKind} ${StatementForm["form"]}`>) =>
			([law, swapped]) =>
				Effect.sync(() => {
					c.note(`${law.kind} ${law.form}`)
					const verdict = (result: ReturnType<typeof ownValue>): void => {
						if (ruled(law.kind)) {
							succeeded(result)
						} else {
							refused(result, "MalformedDescription")
						}
					}
					if (law.form === "description") {
						const statement = ((): StatementDesc => {
							switch (law.kind) {
								case "key":
									return key(derivedSide)
								case "mutable":
									return { kind: "mutable", relation: "TaskIds" }
								case "race":
									return { kind: "race", relation: "TaskIds" }
								case "check":
									return {
										kind: "check",
										name: "Positive",
										relation: "TaskIds",
										predicate: {
											kind: "compare",
											op: "eq",
											left: { kind: "field", field: "id" },
											right: { kind: "field", field: "id" }
										}
									}
								case "contained from":
									return contained(derivedSide, baseSide)
								case "contained into":
									return contained(baseSide, derivedSide)
							}
						})()
						verdict(ownValue(withStatements(statement)))
						return
					}
					const [left, right] = swapped
						? [onBuilder(Task, ["id"]), onBuilder(TaskIds, ["id"])]
						: [onBuilder(TaskIds, ["id"]), onBuilder(Task, ["id"])]
					const extended = (statement: Statement) =>
						ownValue(schema.extend([Work], "Above", [TaskIds], [statement], []))
					switch (law.kind) {
						case "check":
							verdict(
								extended(checkBuilder("Positive", TaskIds, (row: Row) => row.eq(row.id, row.id)))
							)
							return
						case "key":
							verdict(extended(keyBuilder(onBuilder(TaskIds, ["id"]))))
							return
						case "mutable":
							verdict(extended(mutableBuilder(TaskIds)))
							return
						case "race":
							verdict(extended(raceBuilder(TaskIds)))
							return
						case "contained from":
							verdict(
								extended(containedBuilder(onBuilder(TaskIds, ["id"]), onBuilder(Task, ["id"])))
							)
							return
						case "contained into":
							verdict(
								extended(containedBuilder(onBuilder(Task, ["id"]), onBuilder(TaskIds, ["id"])))
							)
							return
						case "mirrors":
							verdict(extended(mirrorsBuilder(left, right)))
							return
					}
				}),
		oracle: {
			kind: "specification",
			name: "the statements a derived relation admits, and the ones it refuses"
		},
		box: "every statement kind over a derived relation, from a description and from the builders",
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/nonempty.ts",
				original: "\tisNonEmpty(xs) ? [xs[0], ...xs.slice(1), last] : [last]",
				replacement: "\tisNonEmpty(xs) ? [xs[0], ...xs.slice(1)] : [last]",
				why: "Operator mutant f2f6277bf3 at packages/text/src/base/nonempty.ts:30 in appendNonEmpty: `, last` becomes ``; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** Scope and structure refuses a description naming what no level declares or breaking a structural rule, each by its documented reason. Its budget is its suite's before it was a property (test/unit/schema/own.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const scopeAndStructureRefusesADescriptionNamingWhatNoLevelDeclaresOrBreakingAStructuralRuleEachByItsDocumentedReason =
	property.explore(
		(source) => ({
			structure: source.draw(element(structures)),
			/** No declared name. */
			name: source.draw(undeclaredWordGen),
			field: source.draw(matching(arkregex("^[a-z]{2,8}[0-9]$"))),
			level: source.draw(int(2, 5)),
			n: source.draw(bigint(0n, 9n)),
			description: source.draw(element<unknown>([42, { name: "X" }, null, "Work"]))
		}),
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: structures satisfies ReadonlyArray<Reached<Structure>>,
			check: (_, c: Case<Structure>) => (s) =>
				Effect.sync(() => {
					c.note(s.structure)
					const d = builtDescOf(Reports)
					const base = baseOf(d)
					const found = Arr.findFirst(
						d.relations,
						(r) => r.kind === "derived" && r.name === "TaskIds"
					)
					if (Option.isNone(found) || found.value.kind !== "derived") {
						return assert.fail("Reports declares TaskIds")
					}
					const taskIds = found.value
					const claims = builtDescOf(schema("P", [Pool, Claim], [], []))
					const owned = (() => {
						switch (s.structure) {
							case "Reports as written":
								return ownValue(Reports)
							case "a key over an undeclared relation":
								return ownValue(withStatements(key(on(s.name, ["id"]))))
							case "a key over an undeclared field":
								return ownValue(withStatements(key(on("Task", [s.field]))))
							case "pred of a field that is not natural":
								return ownValue(withStatements(key(on("Task", ["id", pred("account")]))))
							case "a selection reading an undeclared field":
								return ownValue(
									withStatements(key(onWhere("Task", ["account"], eq(field(s.field), field("id")))))
								)
							case "sides of two widths":
								return ownValue(
									withStatements(contained(on("Task", ["id", "account"]), on("Account", ["id"])))
								)
							case "a closedId over an undeclared roster":
								return ownValue(schema(s.name, [Task], [], []))
							case "a key over a closed relation":
								return ownValue(withStatements(key(on("Kind", ["id"]))))
							case "a closed relation made mutable":
								return ownValue(withStatements({ kind: "mutable", relation: "Kind" }))
							case "a check over a closed relation":
							case "a check reading a parameter":
								return ownValue(
									withStatements({
										kind: "check",
										name: s.name,
										relation: s.structure === "a check over a closed relation" ? "Kind" : "Task",
										predicate: {
											kind: "compare",
											op: "eq",
											left: { kind: "field", field: "id" },
											right:
												s.structure === "a check over a closed relation"
													? { kind: "field", field: "id" }
													: { kind: "param", name: s.field, type: { kind: "uuid" } }
										}
									})
								)
							case "a check over its own row":
								return ownValue(
									schema(
										"Checked",
										Record.values(Work.relations),
										[
											...Work.statements,
											checkBuilder(s.name, Task, (row: Row) => row.ne(row.account, row.id))
										],
										[]
									)
								)
							case "a family counted by no field of its owner":
								return ownValue({ ...claims, statements: [claimsOf("Claim", s.field)] })
							case "a family over no relation":
								return ownValue({ ...claims, statements: [claimsOf(s.name, "n")] })
							case "a derived relation in the root":
								return ownValue({ ...base, relations: [...base.relations, taskIds] })
							case "a derived level that disagrees":
								return ownValue({ ...d, relations: [{ ...taskIds, level: s.level }] })
							case "a definition reading its own level":
								return ownValue({
									...d,
									relations: [
										{
											...taskIds,
											query: definition(
												queryOver(Reports).rule((r: RuleValue) => {
													const { id } = varsOver(TaskIds, "taskIds")
													return r.match(TaskIds, { id }).find({ id })
												})
											)
										}
									]
								})
							case "a parameterized definition":
								return ownValue({
									...d,
									relations: [
										{
											...taskIds,
											query: definition(
												queryOver(Work).rule((r: RuleValue) => {
													const { id } = varsOver(Task, "task")
													return r.match(Task, { id, account: r.param(s.field, Id) }).find({ id })
												})
											)
										}
									]
								})
							case "an extension under its base's name":
								return ownValue({ ...d, name: defined(d.bases[0], "Reports' base").name })
							case "an extension over two bases": {
								const base = defined(d.bases[0], "Reports' base")
								return ownValue({ ...d, bases: [base, base] })
							}
							case "a value that is no description":
								return ownValue(s.description)
						}
					})()
					const expected = answers[s.structure]
					if (expected === "owned") {
						succeeded(owned)
					} else if (typeof expected === "string") {
						refused(owned, expected)
					} else {
						const e = refused(owned, "Refused")
						assert.equal(
							e.reason._tag === "Refused" ? e.reason.refusal : undefined,
							expected.refused
						)
					}
				}),
			oracle: { kind: "specification", name: "each structural rule's documented reason" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/shape.ts",
					original: "\t\t\tif (length > 1) {",
					replacement: "\t\t\tif (length > 2) {",
					why: "A description over two bases is decoded as one over its first, the second dropped, and owned; the two-bases structure's refusal fails."
				}
			]
		}
	)
