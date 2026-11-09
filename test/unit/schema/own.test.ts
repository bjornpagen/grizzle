import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	shuffled
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record, String as Str } from "effect"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { natural, uuid } from "#compiler/public/fields.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { own } from "#compiler/schema/own.ts"
import {
	closed,
	closedRelation,
	materializedDerived,
	drawnField,
	relation
} from "#compiler/schema/relation.ts"
import { schema, schemaDescOf } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	checkBuilder,
	containedBuilder,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	bareContract,
	rawClosedId,
	rawContract,
	rawPg,
	rawSpan,
	type Row,
	regex
} from "#test/unit/schema/support.ts"

import { regex as arkregex } from "arkregex"
/**
 * Ownership: canonical FieldIds, conflict
 * detection, statements over a derived relation, scope rules, and a fingerprint that ignores allocation order and
 * source locations.
 *
 * The oracle is ownership's documented rule (packages/engine/src/schema/own.ts): each property plants one way a declaration
 * breaks it, or one rewrite that keeps its meaning, over drawn names and shapes, and asserts the documented reason or
 * the documented invariance.
 */
const Kind = closed("Kind", ["Automatic", "Manual"], [])
const Account = relation("Account", { id: uuid, name: regex("^[a-z]{1,40}$", "u") }, ["id"], [])
const Task = relation("Task", { id: uuid, account: uuid, kind: rawClosedId(Kind) }, ["id"], [])
const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: rawPg.bigint }, ["task"], [])
const ManualTask = relation("ManualTask", { task: uuid, assignee: uuid }, ["task"], [])

const Work = schema(
	"Work",
	{ Kind, Account, Task, AutomaticTask, ManualTask },
	[
		containedBuilder(onBuilder(Task, ["account"]), onBuilder(Account, ["id"])),
		keyBuilder(onBuilder(Account, ["name"])),
		mutableBuilder(Account),
		alternativesBuilder(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })
	],
	[]
)

const TaskIds = materializedDerived(
	"TaskIds",
	queryOver(Work).rule((r: RuleValue) => {
		const { id, account } = varsOver(Task, "task")
		return r.match(Task, { id, account }).find({ id, account })
	}),
	[]
)
const Reports = schema.extend(Work, "Reports", { TaskIds }, [], [])

const wordGen = matching(arkregex("^[A-Z][a-z]{1,7}$"))

/** The ownership of a value at the schema door: a built schema, or a description decoded there. */
const ownValue = (value: unknown) => ownedInput(value)

const descOf = (s: unknown): SchemaDesc =>
	defined(schemaDescOf(s), "a schema built by schema(...) or schema.extend(...)")

/** The base a schema.extend Description extends. */
const baseOf = (d: SchemaDesc): SchemaDesc => defined(d.extends, `${d.name} extends a schema`)

/** The Description of a query the query builder built, to splice into a description. */
const definition = (q: unknown): QueryDesc =>
	defined(queryValueDesc(q), "a query the query builder built")

/** Reports with extra statements at its top level, as a description TypeScript never checked. */
const withStatements = (...statements: ReadonlyArray<StatementDesc>): SchemaDesc => {
	const d = descOf(Reports)
	return { ...d, statements: [...d.statements, ...statements] }
}

/** The list rotated left by `by` places. */
const rotated = <A>(items: ReadonlyArray<A>, by: number): ReadonlyArray<A> => {
	const k = items.length === 0 ? 0 : by % items.length
	return [...items.slice(k), ...items.slice(0, k)]
}

/**
 * A row check's predicate over Limits as drawn: comparisons with bigint literals, and conjunctions and disjunctions,
 * each node carrying how far a rewrite rotates its operands.
 */
type LimitsPredicate =
	| { readonly kind: "at least"; readonly field: "limit" | "maximum"; readonly n: bigint }
	| { readonly kind: "equal"; readonly field: "limit" | "maximum"; readonly n: bigint }
	| { readonly kind: "within maximum" }
	| {
			readonly kind: "and" | "or"
			readonly args: Arr.NonEmptyReadonlyArray<LimitsPredicate>
			readonly rotate: number
	  }

const limitsAtomGen: Gen<LimitsPredicate> = oneOf([
	map(
		(source) => ({
			field: source.draw(element<"limit" | "maximum">(["limit", "maximum"])),
			n: source.draw(bigint(-5n, 5n))
		}),
		(r): LimitsPredicate => ({ kind: "at least", ...r })
	),
	map(
		(source) => ({
			field: source.draw(element<"limit" | "maximum">(["limit", "maximum"])),
			n: source.draw(bigint(-5n, 5n))
		}),
		(r): LimitsPredicate => ({ kind: "equal", ...r })
	),
	constant<LimitsPredicate>({ kind: "within maximum" })
])

const limitsPredicateGen = (depth: number): Gen<LimitsPredicate> =>
	depth === 0
		? limitsAtomGen
		: oneOf([
				limitsAtomGen,
				map(
					(source) => ({
						kind: source.draw(element<"and" | "or">(["and", "or"])),
						args: source.draw(
							map(
								(source) =>
									[
										source.draw(limitsPredicateGen(depth - 1)),
										source.draw(array(limitsPredicateGen(depth - 1), { min: 0, max: 2 }))
									] as const,
								([first, rest]): Arr.NonEmptyReadonlyArray<LimitsPredicate> => [first, ...rest]
							)
						),
						rotate: source.draw(int(0, 2))
					}),
					(r): LimitsPredicate => r
				)
			])

type LimitsRow = Row & { readonly limit: Row["id"]; readonly maximum: Row["id"] }

/** The predicate built over the row, its and/or operands rotated when `rewrite` holds. */
const limitsPredicate = (r: LimitsRow, p: LimitsPredicate, rewrite: boolean): unknown => {
	switch (p.kind) {
		case "at least":
			return r[p.field].ge(p.n)
		case "equal":
			return r[p.field].eq(p.n)
		case "within maximum":
			return r.le(r.limit, r.maximum)
		case "and":
		case "or": {
			const args = Arr.map(p.args, (a) => limitsPredicate(r, a, rewrite))
			return r[p.kind](...argumentsOf(rewrite ? rotated(args, p.rotate) : args))
		}
	}
}

const hasOrder = (p: LimitsPredicate): boolean =>
	(p.kind === "and" || p.kind === "or") && (p.args.length > 1 || Arr.some(p.args, hasOrder))

type MeaningChange = "none" | "roster order" | "check predicate"

describe("the owned product", () => {
	const Limits = relation(
		"Limits",
		{ id: uuid, limit: rawPg.bigint, maximum: rawPg.bigint },
		["id"],
		[]
	)
	const optional: Arr.NonEmptyReadonlyArray<Statement> = [
		containedBuilder(onBuilder(Task, ["account"]), onBuilder(Account, ["id"])),
		keyBuilder(onBuilder(Account, ["name"])),
		mutableBuilder(Account)
	]
	type FingerprintFeature =
		| Exclude<MeaningChange, "none">
		| "reordered check operands"
		| "repeated statements"
		| "an extension"

	it.effect(
		"fingerprints canonical content: order, repeats and locations drop out, meaning does not, and the canonical description owns to it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/fingerprint",
						draw: drawn((source) => ({
							relationOrder: source.draw(
								shuffled([0, 1, 2, 3], { min: 4, max: [0, 1, 2, 3].length })
							),
							statements: source.draw(shuffled([0, 1, 2], { min: 0, max: [0, 1, 2].length })),
							rewriteOrder: source.draw(int(0, 4)),
							repeats: source.draw(boolean),
							predicate: source.draw(limitsPredicateGen(2)),
							extended: source.draw(boolean),
							change: source.draw(
								element<MeaningChange>(["none", "roster order", "check predicate"])
							)
						})),
						literal: Formatter.format,
						coverage: required<FingerprintFeature>(
							[
								"roster order",
								"check predicate",
								"reordered check operands",
								"repeated statements",
								"an extension"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const relations = (
								roster: AnyClosed
							): ReadonlyArray<readonly [string, AnyRelation | AnyClosed]> => [
								["Kind", roster],
								["Account", Account],
								["Task", Task],
								["Limits", Limits]
							]
							const bounded = (rewrite: boolean, change: boolean) =>
								checkBuilder("Bounded", Limits, (r: LimitsRow) =>
									change
										? r.and(limitsPredicate(r, s.predicate, rewrite), r.limit.ge(-6n))
										: limitsPredicate(r, s.predicate, rewrite)
								)
							const declare = (form: "written" | "rewritten" | "changed") => {
								const rewrite = form === "rewritten"
								const changed = form === "changed"
								const roster =
									changed && s.change === "roster order"
										? closed("Kind", ["Manual", "Automatic"], [])
										: Kind
								const record = Record.fromEntries(
									rewrite
										? Arr.map(s.relationOrder, (i) => defined(relations(roster)[i]))
										: relations(roster)
								)
								const chosen = Arr.map(s.statements, (i) => defined(optional[i]))
								const statements = [
									...(rewrite ? rotated(chosen, s.rewriteOrder) : chosen),
									bounded(rewrite, changed && s.change === "check predicate")
								]
								const all =
									rewrite && s.repeats
										? [...statements, ...statements, bounded(false, false)]
										: statements
								const root = schema("Work", record, rewrite ? Arr.reverse([...all]) : all, [])
								if (!s.extended) {
									return root
								}
								const Ids = materializedDerived(
									"TaskIds",
									queryOver(root).rule((r: RuleValue) => {
										const { id } = varsOver(Task, "task")
										return r.match(Task, { id }).find({ id })
									}),
									[]
								)
								return schema.extend(root, "Above", { TaskIds: Ids }, [], [])
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
							/** The rewritten form owned from its description, relations and statements of every level reversed. */
							const reversed = (d: SchemaDesc): SchemaDesc => ({
								...d,
								relations: Arr.reverse([...d.relations]),
								statements: Arr.reverse([...d.statements]),
								extends: d.extends === undefined ? undefined : reversed(d.extends)
							})
							const written = succeeded(ownValue(declare("written")))
							const rewritten = succeeded(ownValue(reversed(descOf(declare("rewritten")))))
							assert.equal(rewritten.fingerprint, written.fingerprint)
							assert.equal(rewritten.statements.length, written.statements.length)
							assert.equal(Object.isFrozen(written.desc), true)
							assert.equal(succeeded(own(written.desc)).fingerprint, written.fingerprint)
							if (s.change === "none") {
								return
							}
							c.note(s.change)
							assert.notEqual(
								succeeded(ownValue(declare("changed"))).fingerprint,
								written.fingerprint
							)
						})
				)
			)
	)
})

describe("conflicting declarations", () => {
	type Conflict =
		| "a contract name over another base"
		| "a contract name with another predicate"
		| "a relation name across levels"
	const conflicts: Arr.NonEmptyReadonlyArray<Conflict> = [
		"a contract name over another base",
		"a contract name with another predicate",
		"a relation name across levels"
	]

	const atLeast = (n: bigint) => ({
		kind: "compare" as const,
		op: "ge" as const,
		left: { kind: "value" as const },
		right: { kind: "literal" as const, value: n, type: undefined }
	})

	it.effect(
		"refuses a name claimed twice with conflicting meaning, and owns the same meaning twice as one declaration",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/conflicts",
						draw: drawn((source) => ({
							conflict: source.draw(element(conflicts)),
							agree: source.draw(boolean),
							name: source.draw(wordGen),
							n: source.draw(bigint(0n, 9n)),
							swapped: source.draw(boolean)
						})),
						literal: Formatter.format,
						coverage: required<`${Conflict}: ${"refused" | "one declaration"}`>(
							Arr.flatMap(conflicts, (k) => [
								`${k}: refused` as const,
								`${k}: one declaration` as const
							]),
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
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
										const A = relation("A", { id: uuid, amount: first }, ["id"], [])
										const B = relation("B", { id: uuid, amount: second }, ["id"], [])
										return ownValue(schema("Pay", { A, B }, [], []))
									}
									case "a relation name across levels":
										return ownValue(
											schema.extend(
												Work,
												"Above",
												{ Task: s.agree ? Task : relation("Task", { id: uuid }, ["id"], []) },
												[],
												[]
											)
										)
								}
							})()
							if (s.agree) {
								succeeded(owned)
							} else {
								refused(owned, "DuplicateIdentity")
							}
						})
				)
			)
	)
})

const decoded = (d: SchemaDesc) => ownValue(d)

describe("closed relations", () => {
	/**
	 * Where a handle of a closedId field is written: a closed relation's row, a selection or a row check literal, each
	 * built or in a decoded description, which carries no roster for the builders to check.
	 */
	type HandleSite =
		| "a built row"
		| "a decoded row"
		| "a built selection"
		| "a decoded selection"
		| "a built check literal"
		| "a decoded check literal"
	const handleSites: Arr.NonEmptyReadonlyArray<HandleSite> = [
		"a built row",
		"a decoded row",
		"a built selection",
		"a decoded selection",
		"a built check literal",
		"a decoded check literal"
	]

	/** closedId(Kind) under `depth` contracts. */
	const wrapped = (depth: number): FieldBase =>
		depth === 0 ? rawClosedId(Kind) : bareContract(`Grade${depth}`, wrapped(depth - 1))

	it.effect(
		"checks every handle written against a closedId field, at any contract depth, against its roster",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/closed-handles",
						draw: drawn((source) => ({
							site: source.draw(element(handleSites)),
							depth: source.draw(int(0, 3)),
							handle: source.draw(
								oneOf([
									element(["Automatic", "Manual"]),
									filter(wordGen, (w) => w !== "Automatic" && w !== "Manual", 100)
								])
							)
						})),
						literal: Formatter.format,
						coverage: required<
							`${HandleSite}: ${"on the roster" | "off the roster"}` | "nested contracts"
						>(
							[
								...Arr.flatMap(handleSites, (site) => [
									`${site}: on the roster` as const,
									`${site}: off the roster` as const
								]),
								"nested contracts"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const onRoster = s.handle === "Automatic" || s.handle === "Manual"
							c.note(`${s.site}: ${onRoster ? "on the roster" : "off the roster"}`)
							if (s.depth > 1) {
								c.note("nested contracts")
							}
							const grade = wrapped(s.depth)
							/** Graded relates each Level to a grade, a closed relation keyed by the roster Level. */
							const Level = closed("Level", ["Low", "High"], [])
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
							const Rated = relation("Rated", { id: uuid, grade }, ["id"], [])
							const valid = descOf(schema("W", { Kind, Level, Graded, Rated, Task }, [], []))
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
											r.grade.eq(s.handle)
										)
									case "a built check literal":
										return checkBuilder("Graded", Rated, (r: Row & { readonly grade: Row["id"] }) =>
											r.grade.eq(s.handle)
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
														right: { kind: "literal", value: s.handle, type: undefined }
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
						})
				)
			)
	)

	it.effect(
		"refuses a handle longer than a name's 63 bytes, the most a roster's names constant holds, built or decoded",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/handle-name-bytes",
						draw: drawn((source) => ({
							accented: source.draw(int(0, 31)),
							delta: source.draw(int(-3, 3)),
							decoded: source.draw(boolean)
						})),
						literal: Formatter.format,
						coverage: required<
							`${"built" | "decoded"} ${"within" | "above"}` | "at 63 bytes" | "at 64 bytes"
						>(
							[
								"built within",
								"built above",
								"decoded within",
								"decoded above",
								"at 63 bytes",
								"at 64 bytes"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
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
								const build = () => closed("Long", [handle], [])
								if (within) {
									succeeded(ownValue(schema("W", { Long: build() }, [], [])))
								} else {
									throwsRefused(build, "MalformedDescription")
								}
								return
							}
							const d = descOf(schema("W", { Kind }, [], []))
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
						})
				)
			)
	)
})

describe("statements over a derived relation", () => {
	type DerivedStatementKind =
		| "key"
		| "mutable"
		| "check"
		| "contained from"
		| "contained into"
		| "mirrors"
		| "an alternatives arm"
	/**
	 * Each statement in each form it is written in: a description or a builder. mirrors is a builder's alone: it is sugar,
	 * which a description states as its two containments, the contained statements.
	 */
	type StatementForm =
		| { readonly kind: Exclude<DerivedStatementKind, "mirrors">; readonly form: "description" }
		| { readonly kind: DerivedStatementKind; readonly form: "builder" }
	const described: Arr.NonEmptyReadonlyArray<Exclude<DerivedStatementKind, "mirrors">> = [
		"key",
		"mutable",
		"check",
		"contained from",
		"contained into",
		"an alternatives arm"
	]
	const statementForms: Arr.NonEmptyReadonlyArray<StatementForm> = [
		...Arr.map(described, (kind): StatementForm => ({ kind, form: "description" })),
		...Arr.map([...described, "mirrors" as const], (kind): StatementForm => ({
			kind,
			form: "builder"
		}))
	]
	/** Whether ownership reads the statement as a rule over the derived relation's definition: every rule but those that
	 * name rows grizzle writes, mutable's and an alternatives arm's, which it refuses as MalformedDescription. */
	const ruled = (kind: DerivedStatementKind): boolean =>
		kind !== "mutable" && kind !== "an alternatives arm"
	const derivedSide = on("TaskIds", ["id"])
	const baseSide = on("Task", ["id"])

	it.effect(
		"owns a key, check, containment either way and mirrors over a derived relation, and refuses mutable and an alternatives arm over one, from a description or the builders",
		(ctx) =>
			Effect.gen(function* () {
				const space: Gen<readonly [StatementForm, boolean]> = (source) =>
					[source.draw(element(statementForms)), source.draw(boolean)] as const
				yield* searched(
					ctx,
					exhaust(
						{
							box: { kind: "unstated" },
							oracle: { kind: "unstated" },
							suite: "unit/schema/statements-over-derived",
							generator: space,
							literal: Formatter.format,
							/** The space is every statement form, 6 described and 7 built, with its sides either way round. */
							limit: 26,
							coverage: requiredInSpace<`${DerivedStatementKind} ${StatementForm["form"]}`>(
								Arr.map(statementForms, (l) => `${l.kind} ${l.form}` as const)
							),
							caseHang
						},
						([law, swapped], c) =>
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
											case "an alternatives arm":
												return {
													kind: "alternatives",
													parent: baseSide,
													discriminator: "kind",
													roster: "Kind",
													arms: [{ handle: "Automatic", arm: derivedSide }]
												}
										}
									})()
									verdict(ownValue(withStatements(statement)))
									return
								}
								const [left, right] = swapped
									? [onBuilder(Task, ["id"]), onBuilder(TaskIds, ["id"])]
									: [onBuilder(TaskIds, ["id"]), onBuilder(Task, ["id"])]
								const extended = (statement: Statement) =>
									ownValue(schema.extend(Work, "Above", { TaskIds }, [statement], []))
								switch (law.kind) {
									case "check":
										verdict(
											extended(checkBuilder("Positive", TaskIds, (row: Row) => row.id.eq(row.id)))
										)
										return
									case "an alternatives arm":
										throwsRefused(
											() => alternativesBuilder(Task, "kind", Kind, { Automatic: TaskIds }),
											"MalformedDescription"
										)
										return
									case "key":
										verdict(extended(keyBuilder(onBuilder(TaskIds, ["id"]))))
										return
									case "mutable":
										verdict(extended(mutableBuilder(TaskIds)))
										return
									case "contained from":
										verdict(
											extended(
												containedBuilder(onBuilder(TaskIds, ["id"]), onBuilder(Task, ["id"]))
											)
										)
										return
									case "contained into":
										verdict(
											extended(
												containedBuilder(onBuilder(Task, ["id"]), onBuilder(TaskIds, ["id"]))
											)
										)
										return
									case "mirrors":
										verdict(extended(mirrorsBuilder(left, right)))
										return
								}
							})
					)
				)
			})
	)
})

describe("scope and structure", () => {
	/**
	 * A description that names what no level declares, or breaks a structural rule ownership documents, each planted
	 * alone into Reports, which owns as it is; and the forms the same rules admit.
	 */
	type Structure =
		| "Reports as written"
		| "a key over an undeclared relation"
		| "a key over an undeclared field"
		| "pred of a field that is not natural"
		| "a selection reading an undeclared field"
		| "sides of two widths"
		| "a closedId over an undeclared roster"
		| "a key over a closed relation"
		| "a closed relation made mutable"
		| "a check over a closed relation"
		| "a check reading a parameter"
		| "a check over its own row"
		| "a family counted by no field of its owner"
		| "a family over no relation"
		| "a derived relation in the root"
		| "a derived level that disagrees"
		| "a definition reading its own level"
		| "a parameterized definition"
		| "an extension under its base's name"
		| "a value that is no description"
	const structures: Arr.NonEmptyReadonlyArray<Structure> = [
		"Reports as written",
		"a key over an undeclared relation",
		"a key over an undeclared field",
		"pred of a field that is not natural",
		"a selection reading an undeclared field",
		"sides of two widths",
		"a closedId over an undeclared roster",
		"a key over a closed relation",
		"a closed relation made mutable",
		"a check over a closed relation",
		"a check reading a parameter",
		"a check over its own row",
		"a family counted by no field of its owner",
		"a family over no relation",
		"a derived relation in the root",
		"a derived level that disagrees",
		"a definition reading its own level",
		"a parameterized definition",
		"an extension under its base's name",
		"a value that is no description"
	]
	/** What ownership answers each with: success, or its documented reason. */
	const answer = (s: Structure): "owned" | "MalformedDescription" | "IdentifierCollision" =>
		s === "Reports as written" || s === "a check over its own row"
			? "owned"
			: s === "an extension under its base's name"
				? "IdentifierCollision"
				: "MalformedDescription"

	/** A pool's claims, a counted family of Claim over Pool's drawn count n. */
	const Pool = relation("Pool", { id: uuid, n: drawnField(natural, []) }, ["id"], [])
	const Claim = relation("Claim", { id: uuid, pool: uuid }, ["id"], [])
	const claimsOf = (member: string, count: string): StatementDesc => ({
		kind: "family",
		order: "counted",
		member: on(member, ["pool"]),
		slots: { owner: "Pool", count }
	})

	it.effect(
		"refuses a description naming what no level declares or breaking a structural rule, each by its documented reason",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/schema/structure",
						draw: drawn((source) => ({
							structure: source.draw(element(structures)),
							/** No declared name. */
							name: source.draw(
								filter(wordGen, (w) => !["Kind", "Account", "Task", "Work"].includes(w), 100)
							),
							field: source.draw(
								filter(
									matching(arkregex("^[a-z]{2,8}$")),
									(f) => !["id", "account", "kind", "budget", "units", "pool"].includes(f),
									100
								)
							),
							level: source.draw(int(2, 5)),
							n: source.draw(bigint(0n, 9n)),
							description: source.draw(element<unknown>([42, { name: "X" }, null, "Work"]))
						})),
						literal: Formatter.format,
						coverage: required<Structure>(structures, { cases: 400, sense: notesOnly }),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.structure)
							const d = descOf(Reports)
							const base = baseOf(d)
							const found = Arr.findFirst(
								d.relations,
								(r) => r.kind === "derived" && r.name === "TaskIds"
							)
							if (Option.isNone(found) || found.value.kind !== "derived") {
								return assert.fail("Reports declares TaskIds")
							}
							const taskIds = found.value
							const claims = descOf(schema("P", { Pool, Claim }, [], []))
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
											withStatements(
												key(onWhere("Task", ["account"], eq(field(s.field), field("id"))))
											)
										)
									case "sides of two widths":
										return ownValue(
											withStatements(
												contained(on("Task", ["id", "account"]), on("Account", ["id"]))
											)
										)
									case "a closedId over an undeclared roster":
										return ownValue(schema(s.name, { Task }, [], []))
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
												relation:
													s.structure === "a check over a closed relation" ? "Kind" : "Task",
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
												Work.relations,
												[
													...Work.statements,
													checkBuilder(s.name, Task, (row: Row) => row.account.ne(row.id))
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
															return r
																.match(Task, { id, account: r.param(s.field, uuid) })
																.find({ id })
														})
													)
												}
											]
										})
									case "an extension under its base's name":
										return ownValue({ ...d, name: defined(d.extends, "Reports' base").name })
									case "a value that is no description":
										return ownValue(s.description)
								}
							})()
							const expected = answer(s.structure)
							if (expected === "owned") {
								succeeded(owned)
							} else {
								refused(owned, expected)
							}
						})
				)
			)
	)
})
