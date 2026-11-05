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
import { Array as Arr, Duration, Effect, Formatter, Option, Record, String as Str } from "effect"
import type { QueryDesc, SideDesc } from "#compiler/ir/desc.ts"
import { uuid } from "#compiler/public/fields.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { own } from "#compiler/schema/own.ts"
import { closed, derived, relation } from "#compiler/schema/relation.ts"
import { schema, schemaDescOf } from "#compiler/schema/schema.ts"
import {
	alternatives,
	capacity,
	check,
	contained,
	key,
	mirrors,
	mutable,
	on,
	select,
	within
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { assert, defined, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import type {
	SchemaDesc,
	AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
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
 * detection, LawOnDerived, scope rules, and a fingerprint that ignores allocation order and source locations.
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
		contained(on(Task, ["account"]), on(Account, ["id"])),
		key(Account, ["name"]),
		mutable(Account),
		alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })
	],
	[]
)

const TaskIds = derived(
	"TaskIds",
	queryOver(Work).rule((r: RuleValue) => {
		const { id, account } = varsOver(Task, "task")
		return r.match(Task, { id, account }).find({ id, account })
	}),
	[]
)
const Reports = schema.extend(Work, { TaskIds }, [], [])

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
		contained(on(Task, ["account"]), on(Account, ["id"])),
		key(Account, ["name"]),
		mutable(Account)
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
						caseHang: Duration.minutes(2)
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
								check("Bounded", Limits, (r: LimitsRow) =>
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
								const Ids = derived(
									"TaskIds",
									queryOver(root).rule((r: RuleValue) => {
										const { id } = varsOver(Task, "task")
										return r.match(Task, { id }).find({ id })
									}),
									[]
								)
								return schema.extend(root, { TaskIds: Ids }, [], [])
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
		| "the alternatives head written out"
		| "an arm's mirrors written out"
		| "an arm written as its two containments"
	const conflicts: Arr.NonEmptyReadonlyArray<Conflict> = [
		"a contract name over another base",
		"a contract name with another predicate",
		"a relation name across levels",
		"the alternatives head written out",
		"an arm's mirrors written out",
		"an arm written as its two containments"
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
						suite: "unit/schema/conflicts",
						draw: drawn((source) => ({
							conflict: source.draw(element(conflicts)),
							agree: source.draw(boolean),
							name: source.draw(wordGen),
							n: source.draw(bigint(0n, 9n)),
							swapped: source.draw(boolean),
							arm: source.draw(element<"Automatic" | "Manual">(["Automatic", "Manual"]))
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
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(`${s.conflict}: ${s.agree ? "one declaration" : "refused"}`)
							const armRelation = s.arm === "Automatic" ? AutomaticTask : ManualTask
							const armKey = on(armRelation, ["task"])
							const selected = on(select(Task, { kind: s.arm }), ["id"])
							const helper = alternatives(Task, "kind", Kind, {
								Automatic: AutomaticTask,
								Manual: ManualTask
							})
							const helped = (...more: ReadonlyArray<Statement>) =>
								ownValue(
									schema("W", { Kind, Task, AutomaticTask, ManualTask }, [helper, ...more], [])
								)
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
												{ Task: s.agree ? Task : relation("Task", { id: uuid }, ["id"], []) },
												[],
												[]
											)
										)
									case "the alternatives head written out":
										return s.agree
											? helped(contained(on(Task, ["account"]), on(Task, ["id"])))
											: helped(contained(on(Task, ["kind"]), on(Kind, ["id"])))
									case "an arm's mirrors written out":
										return s.agree
											? helped(mirrors(on(Task, ["account"]), armKey))
											: helped(s.swapped ? mirrors(armKey, selected) : mirrors(selected, armKey))
									case "an arm written as its two containments":
										return s.agree
											? helped(
													s.swapped ? contained(armKey, selected) : contained(selected, armKey)
												)
											: helped(contained(selected, armKey), contained(armKey, selected))
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
	 * Where a handle of a closedId field is written: a closed payload fact, a selection or a row check literal, each
	 * built or in a decoded description, which carries no roster for the builders to check.
	 */
	type HandleSite =
		| "a built fact"
		| "a decoded fact"
		| "a built selection"
		| "a decoded selection"
		| "a built check literal"
		| "a decoded check literal"
	const handleSites: Arr.NonEmptyReadonlyArray<HandleSite> = [
		"a built fact",
		"a decoded fact",
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
						caseHang: Duration.minutes(2)
					},
					(s, c) =>
						Effect.sync(() => {
							const onRoster = s.handle === "Automatic" || s.handle === "Manual"
							c.note(`${s.site}: ${onRoster ? "on the roster" : "off the roster"}`)
							if (s.depth > 1) {
								c.note("nested contracts")
							}
							const grade = wrapped(s.depth)
							const Graded = closed("Graded", ["Low", "High"], []).with(
								{ grade },
								{ Low: { grade: "Automatic" }, High: { grade: "Manual" } }
							)
							const Rated = relation("Rated", { id: uuid, grade }, ["id"], [])
							const valid = descOf(schema("W", { Kind, Graded, Rated, Task }, [], []))
							const build = (): unknown => {
								switch (s.site) {
									case "a built fact":
										return closed("Graded", ["Low"], []).with(
											{ grade },
											{ Low: { grade: s.handle } }
										)
									case "a built selection":
										return select(Rated, { grade: s.handle })
									case "a built check literal":
										return check("Graded", Rated, (r: Row & { readonly grade: Row["id"] }) =>
											r.grade.eq(s.handle)
										)
									case "a decoded fact":
									case "a decoded selection":
									case "a decoded check literal":
										return undefined
								}
							}
							const result = (() => {
								switch (s.site) {
									case "a decoded fact":
										return decoded({
											...valid,
											relations: Arr.map(valid.relations, (r) =>
												r.kind === "closed" && r.name === "Graded"
													? { ...r, facts: { ...r.facts, High: { grade: s.handle } } }
													: r
											)
										})
									case "a decoded selection":
										return decoded({
											...valid,
											statements: [
												{
													kind: "contained",
													left: {
														relation: "Rated",
														fields: ["id"],
														selection: { grade: s.handle }
													},
													right: { relation: "Task", fields: ["id"], selection: {} },
													origin: undefined
												}
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
									case "a built fact":
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
		"refuses a handle longer than a PostgreSQL enum label's 63 bytes, built or decoded",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/enum-label-bytes",
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
						caseHang: Duration.minutes(2)
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
									r.kind === "closed" ? { ...r, handles: [handle], facts: { [handle]: {} } } : r
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

describe("LawOnDerived", () => {
	type LawOnDerivedKind =
		| "key"
		| "mutable"
		| "check"
		| "contained from"
		| "contained into"
		| "mirrors"
		| "capacity target"
		| "capacity source"
		| "an alternatives arm"
	const lawKinds: Arr.NonEmptyReadonlyArray<LawOnDerivedKind> = [
		"key",
		"mutable",
		"check",
		"contained from",
		"contained into",
		"mirrors",
		"capacity target",
		"capacity source",
		"an alternatives arm"
	]
	const derivedSide: SideDesc = { relation: "TaskIds", fields: ["id"], selection: {} }
	const baseSide: SideDesc = { relation: "Task", fields: ["id"], selection: {} }

	it.effect(
		"refuses every law statement naming a derived relation, from a description or the builders",
		(ctx) =>
			Effect.gen(function* () {
				const space: Gen<readonly [LawOnDerivedKind, "description" | "builder", boolean]> = (
					source
				) =>
					[
						source.draw(element(lawKinds)),
						source.draw(element(["description" as const, "builder" as const])),
						source.draw(boolean)
					] as const
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/schema/law-on-derived",
							generator: space,
							literal: Formatter.format,
							limit: 36,
							coverage: requiredInSpace<`${LawOnDerivedKind} ${"description" | "builder"}`>(
								Arr.flatMap(lawKinds, (k) => [`${k} description` as const, `${k} builder` as const])
							),
							caseHang: Duration.minutes(2)
						},
						([kind, form, swapped], c) =>
							Effect.sync(() => {
								c.note(`${kind} ${form}`)
								const [l, r] = swapped ? [baseSide, derivedSide] : [derivedSide, baseSide]
								if (form === "description") {
									const statement = ((): StatementDesc => {
										switch (kind) {
											case "key":
												return { kind: "key", relation: "TaskIds", fields: ["id"] }
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
												return {
													kind: "contained",
													left: derivedSide,
													right: baseSide,
													origin: undefined
												}
											case "contained into":
												return {
													kind: "contained",
													left: baseSide,
													right: derivedSide,
													origin: undefined
												}
											case "mirrors":
												return { kind: "mirrors", left: l, right: r, origin: undefined }
											case "capacity target":
												return {
													kind: "capacity",
													target: derivedSide,
													from: baseSide,
													weight: { kind: "count" },
													within: { low: 0n, high: 1n }
												}
											case "capacity source":
												return {
													kind: "capacity",
													target: baseSide,
													from: derivedSide,
													weight: { kind: "count" },
													within: { low: 0n, high: "*" }
												}
											case "an alternatives arm":
												return {
													kind: "mirrors",
													left: {
														relation: "Task",
														fields: ["id"],
														selection: { kind: "Automatic" }
													},
													right: derivedSide,
													origin: { alternatives: "Task.kind" }
												}
										}
									})()
									refused(ownValue(withStatements(statement)), "LawOnDerived")
									return
								}
								const [left, right] = swapped
									? [on(Task, ["id"]), on(TaskIds, ["id"])]
									: [on(TaskIds, ["id"]), on(Task, ["id"])]
								const extended = (statement: Statement) =>
									ownValue(schema.extend(Work, { TaskIds }, [statement], []))
								switch (kind) {
									case "check":
										throwsRefused(
											() => check("Positive", TaskIds, (row: Row) => row.id.eq(row.id)),
											"LawOnDerived"
										)
										return
									case "an alternatives arm":
										throwsRefused(
											() => alternatives(Task, "kind", Kind, { Automatic: TaskIds }),
											"LawOnDerived"
										)
										return
									case "key":
										refused(extended(key(TaskIds, ["id"])), "LawOnDerived")
										return
									case "mutable":
										refused(extended(mutable(TaskIds)), "LawOnDerived")
										return
									case "contained from":
										refused(
											extended(contained(on(TaskIds, ["id"]), on(Task, ["id"]))),
											"LawOnDerived"
										)
										return
									case "contained into":
										refused(
											extended(contained(on(Task, ["id"]), on(TaskIds, ["id"]))),
											"LawOnDerived"
										)
										return
									case "mirrors":
										refused(extended(mirrors(left, right)), "LawOnDerived")
										return
									case "capacity target":
										refused(
											extended(
												capacity(on(TaskIds, ["id"]), {
													from: on(Task, ["id"]),
													within: within(0n, 1n)
												})
											),
											"LawOnDerived"
										)
										return
									case "capacity source":
										refused(
											extended(
												capacity(on(Task, ["id"]), {
													from: on(TaskIds, ["id"]),
													within: within(0n, "*")
												})
											),
											"LawOnDerived"
										)
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
		| "sides of two widths"
		| "a closedId over an undeclared roster"
		| "a key over a closed relation"
		| "a closed relation made mutable"
		| "a check over a closed relation"
		| "a check reading a parameter"
		| "a check over its own row"
		| "a capacity bound naming no target field"
		| "a capacity weight naming no source field"
		| "a capacity bound whose low exceeds its high"
		| "a derived relation in the root"
		| "a derived level that disagrees"
		| "a definition reading its own level"
		| "a parameterized definition"
		| "an extension under another name"
		| "a value that is no description"
	const structures: Arr.NonEmptyReadonlyArray<Structure> = [
		"Reports as written",
		"a key over an undeclared relation",
		"a key over an undeclared field",
		"sides of two widths",
		"a closedId over an undeclared roster",
		"a key over a closed relation",
		"a closed relation made mutable",
		"a check over a closed relation",
		"a check reading a parameter",
		"a check over its own row",
		"a capacity bound naming no target field",
		"a capacity weight naming no source field",
		"a capacity bound whose low exceeds its high",
		"a derived relation in the root",
		"a derived level that disagrees",
		"a definition reading its own level",
		"a parameterized definition",
		"an extension under another name",
		"a value that is no description"
	]
	/** What ownership answers each with: success, or its documented reason. */
	const answer = (s: Structure): "owned" | "MalformedDescription" =>
		s === "Reports as written" || s === "a check over its own row"
			? "owned"
			: "MalformedDescription"

	const Pool = relation("Pool", { id: uuid, budget: rawPg.bigint }, ["id"], [])
	const Claim = relation("Claim", { id: uuid, pool: uuid, units: rawPg.bigint }, ["id"], [])
	const capacityOf = (target: string, weight: string, low: bigint): StatementDesc => ({
		kind: "capacity",
		target: { relation: "Pool", fields: ["id"], selection: {} },
		from: { relation: "Claim", fields: ["pool"], selection: {} },
		weight: { kind: "field", field: weight },
		within: { low, high: { ref: target } }
	})

	it.effect(
		"refuses a description naming what no level declares or breaking a structural rule, each by its documented reason",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
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
						caseHang: Duration.minutes(2)
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
							const capacities = descOf(schema("P", { Pool, Claim }, [], []))
							const owned = (() => {
								switch (s.structure) {
									case "Reports as written":
										return ownValue(Reports)
									case "a key over an undeclared relation":
										return ownValue(
											withStatements({ kind: "key", relation: s.name, fields: ["id"] })
										)
									case "a key over an undeclared field":
										return ownValue(
											withStatements({ kind: "key", relation: "Task", fields: [s.field] })
										)
									case "sides of two widths":
										return ownValue(
											withStatements({
												kind: "contained",
												left: { relation: "Task", fields: ["id", "account"], selection: {} },
												right: { relation: "Account", fields: ["id"], selection: {} },
												origin: undefined
											})
										)
									case "a closedId over an undeclared roster":
										return ownValue(schema(s.name, { Task }, [], []))
									case "a key over a closed relation":
										return ownValue(
											withStatements({ kind: "key", relation: "Kind", fields: ["id"] })
										)
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
											schema.extend(
												Work,
												{},
												[check(s.name, Task, (row: Row) => row.account.ne(row.id))],
												[]
											)
										)
									case "a capacity bound naming no target field":
										return ownValue({
											...capacities,
											statements: [capacityOf(s.field, "units", 0n)]
										})
									case "a capacity weight naming no source field":
										return ownValue({
											...capacities,
											statements: [capacityOf("budget", s.field, 0n)]
										})
									case "a capacity bound whose low exceeds its high":
										return ownValue({
											...capacities,
											statements: [
												{
													kind: "capacity",
													target: { relation: "Pool", fields: ["id"], selection: {} },
													from: { relation: "Claim", fields: ["pool"], selection: {} },
													weight: { kind: "count" },
													within: { low: s.n + 1n, high: s.n }
												}
											]
										})
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
									case "an extension under another name":
										return ownValue({ ...d, name: s.name })
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
