/** What the properties of own.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { bigint } from "@bjornpagen/testing/values"
import { regex as arkregex } from "arkregex"
import { Array as Arr } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { natural } from "#compiler/public/fields.ts"
import { queryOver, queryValueDesc, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import {
	closedBuilder as closed,
	drawnField,
	materializedDerived,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import { schemaBuilder as schema, schemaDescOf } from "#compiler/schema/schema.ts"
import {
	alternativesBuilder,
	containedBuilder,
	keyBuilder,
	mutableBuilder,
	onBuilder,
	unitBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import {
	on,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import { argumentsOf } from "#test/support/list.ts"
import { ownInput } from "#test/support/policy.ts"
import { bareContract, rawClosedId, rawPg, regex, type Row } from "#test/unit/schema/support.ts"

/** The handles of Kind, a roster. */
const kindHandles = ["Automatic", "Manual"] as const

/**
 * Ownership: canonical FieldIds, conflict
 * detection, statements over a derived relation, scope rules, and a fingerprint that ignores allocation order and
 * source locations.
 *
 * The oracle is ownership's documented rule (packages/engine/src/schema/own.ts): each property plants one way a declaration
 * breaks it, or one rewrite that keeps its meaning, over drawn names and shapes, and asserts the documented reason or
 * the documented invariance.
 */
export const Kind = closed("Kind", kindHandles, "ordered", [])

export const Account = relation(
	"Account",
	{ id: Id, name: regex("^[a-z]{1,40}$", "u") },
	["id"],
	[]
)

export const Task = relation("Task", { id: Id, account: Id, kind: rawClosedId(Kind) }, ["id"], [])

const AutomaticTask = relation("AutomaticTask", { task: Id, budget: rawPg.bigint }, ["task"], [])

const ManualTask = relation("ManualTask", { task: Id, assignee: Id }, ["task"], [])

/** The unit of a row's own id, which Account and Task sit in, so Account is mutable inside it. */
export const entity = unitBuilder("Entity", { id: Id }, [])

export const Work = schema(
	"Work",
	[Kind, Account, Task, AutomaticTask, ManualTask],
	[
		containedBuilder(onBuilder(Task, ["account"]), onBuilder(Account, ["id"])),
		keyBuilder(onBuilder(Account, ["name"])),
		entity,
		mutableBuilder(Account),
		alternativesBuilder(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })
	],
	[]
)

export const TaskIds = materializedDerived(
	"TaskIds",
	queryOver(Work).rule((r: RuleValue) => {
		const { id, account } = varsOver(Task, "task")
		return r.match(Task, { id, account }).find({ id, account })
	}),
	[]
)

export const Reports = schema.extend([Work], "Reports", [TaskIds], [], [])

/**
 * A word no fixture declares, as a name or a handle: a word that ends in a digit, which no declared name or handle of the
 * fixtures does.
 */
export const undeclaredWordGen = matching(arkregex("^[A-Z][a-z]{1,7}[0-9]$"))

/** The ownership of a value at the schema door: a built schema, or a description decoded there. */
export const ownValue = (value: unknown) => Result.flatMap(parseSchemaInput(value), ownInput)

export const builtDescOf = (s: unknown): SchemaDesc =>
	defined(schemaDescOf(s), "a schema built by schema(...) or schema.extend(...)")

/** The base a schema.extend Description extends. */
export const baseOf = (d: SchemaDesc): SchemaDesc =>
	defined(d.bases[0], `${d.name} extends a schema`)

/** The Description of a query the query builder built, to splice into a description. */
export const definition = (q: unknown): QueryDesc =>
	defined(queryValueDesc(q), "a query the query builder built")

/** Reports with extra statements at its top level, as a description TypeScript never checked. */
export const withStatements = (...statements: ReadonlyArray<StatementDesc>): SchemaDesc => {
	const d = builtDescOf(Reports)
	return { ...d, statements: [...d.statements, ...statements] }
}

/** The list rotated left by `by` places. */
export const rotated = <A>(items: ReadonlyArray<A>, by: number): ReadonlyArray<A> => {
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

const limitsAtomGen: Gen<LimitsPredicate> = weighted([
	[
		1,
		map(
			(source) => ({
				field: source.draw(element<"limit" | "maximum">(["limit", "maximum"])),
				n: source.draw(bigint(-5n, 5n))
			}),
			(r): LimitsPredicate => ({ kind: "at least", ...r })
		)
	],
	[
		1,
		map(
			(source) => ({
				field: source.draw(element<"limit" | "maximum">(["limit", "maximum"])),
				n: source.draw(bigint(-5n, 5n))
			}),
			(r): LimitsPredicate => ({ kind: "equal", ...r })
		)
	],
	[1, constant<LimitsPredicate>({ kind: "within maximum" })]
])

export const limitsPredicateGen = (depth: number): Gen<LimitsPredicate> =>
	depth === 0
		? limitsAtomGen
		: weighted([
				[1, limitsAtomGen],
				[
					1,
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
				]
			])

export type LimitsRow = Row & { readonly limit: Row["id"]; readonly maximum: Row["id"] }

/** The predicate built over the row, its and/or operands rotated when `rewrite` holds. */
export const limitsPredicate = (r: LimitsRow, p: LimitsPredicate, rewrite: boolean): unknown => {
	switch (p.kind) {
		case "at least":
			return r.ge(r[p.field], p.n)
		case "equal":
			return r.eq(r[p.field], p.n)
		case "within maximum":
			return r.le(r.limit, r.maximum)
		case "and":
		case "or": {
			const args = Arr.map(p.args, (a) => limitsPredicate(r, a, rewrite))
			return r[p.kind](...argumentsOf(rewrite ? rotated(args, p.rotate) : args))
		}
	}
}

export const hasOrder = (p: LimitsPredicate): boolean =>
	(p.kind === "and" || p.kind === "or") && (p.args.length > 1 || Arr.some(p.args, hasOrder))

export type MeaningChange = "none" | "roster order" | "check predicate" | "closed row"

/** The handles of Level, a roster, which keys Grade beside Kind. */
const levelHandles = ["Low", "Mid", "High"] as const

/** The keys of Grade, a closed relation keyed by Kind and Level: every pair of their handles. */
const gradeKeys = Object.freeze(
	Arr.flatMap(levelHandles, (level) => Arr.map(kindHandles, (kind) => ({ kind, level })))
)

/**
 * The fact of Grade's key number `i`: its weight `i`, or, where `heavier` holds, a weight no key's fact holds, which
 * changes the fact.
 */
export const gradeFact = (i: number, heavier: boolean) => ({
	...defined(gradeKeys[i], "a key of Grade"),
	weight: heavier ? gradeKeys.length + i : i
})

/** Grade's key numbers, in the order its written form writes its rows. */
export const gradeOrder = Object.freeze(Arr.map(gradeKeys, (_, i) => i))

/** The places of the fingerprint search's relations in its written form: Kind, Level, Grade, Account, Task, Limits. */
export const relationPlaces = Object.freeze([0, 1, 2, 3, 4, 5])

export const Limits = relation(
	"Limits",
	{ id: Id, limit: rawPg.bigint, maximum: rawPg.bigint },
	["id"],
	[]
)

export const optional: Arr.NonEmptyReadonlyArray<Statement> = [
	containedBuilder(onBuilder(Task, ["account"]), onBuilder(Account, ["id"])),
	keyBuilder(onBuilder(Account, ["name"])),
	mutableBuilder(Account)
]

export type FingerprintFeature =
	| Exclude<MeaningChange, "none">
	| "reordered check operands"
	| "reordered closed rows"
	| "repeated statements"
	| "an extension"

export const Level = closed("Level", [...levelHandles], "ordered", [])

export type Conflict =
	| "a contract name over another base"
	| "a contract name with another predicate"
	| "a relation name across levels"

export const conflicts: Arr.NonEmptyReadonlyArray<Conflict> = [
	"a contract name over another base",
	"a contract name with another predicate",
	"a relation name across levels"
]

export const atLeast = (n: bigint) => ({
	kind: "compare" as const,
	op: "ge" as const,
	left: { kind: "value" as const },
	right: { kind: "literal" as const, value: n }
})

export const decoded = (d: SchemaDesc) => ownValue(d)

/**
 * Where a handle of a closedId field is written: a closed relation's row, a selection or a row check literal, each
 * built or in a decoded description, which carries no roster for the builders to check.
 */
export type HandleSite =
	| "a built row"
	| "a decoded row"
	| "a built selection"
	| "a decoded selection"
	| "a built check literal"
	| "a decoded check literal"

export const handleSites: Arr.NonEmptyReadonlyArray<HandleSite> = [
	"a built row",
	"a decoded row",
	"a built selection",
	"a decoded selection",
	"a built check literal",
	"a decoded check literal"
]

/** closedId(Kind) under `depth` contracts. */
export const wrapped = (depth: number): FieldBase =>
	depth === 0 ? rawClosedId(Kind) : bareContract(`Grade${depth}`, wrapped(depth - 1))

export type DerivedStatementKind =
	| "key"
	| "mutable"
	| "race"
	| "check"
	| "contained from"
	| "contained into"
	| "mirrors"
	| "an alternatives arm"

/**
 * Each statement in each form it is written in: a description or a builder. mirrors is a builder's alone: it is sugar,
 * which a description states as its two containments, the contained statements.
 */
export type StatementForm =
	| { readonly kind: Exclude<DerivedStatementKind, "mirrors">; readonly form: "description" }
	| { readonly kind: DerivedStatementKind; readonly form: "builder" }

const described: Arr.NonEmptyReadonlyArray<Exclude<DerivedStatementKind, "mirrors">> = [
	"key",
	"mutable",
	"race",
	"check",
	"contained from",
	"contained into",
	"an alternatives arm"
]

export const statementForms: Arr.NonEmptyReadonlyArray<StatementForm> = [
	...Arr.map(described, (kind): StatementForm => ({ kind, form: "description" })),
	...Arr.map([...described, "mirrors" as const], (kind): StatementForm => ({
		kind,
		form: "builder"
	}))
]

/** Whether ownership reads the statement as a rule over the derived relation's definition: every rule but those that
 * name rows grizzle writes, mutable's, race's and an alternatives arm's, which it refuses as MalformedDescription. */
export const ruled = (kind: DerivedStatementKind): boolean =>
	kind !== "mutable" && kind !== "race" && kind !== "an alternatives arm"

export const derivedSide = on("TaskIds", ["id"])

export const baseSide = on("Task", ["id"])

/** Each statement form, the mirrors' sides in either order. */
export const space: Gen<readonly [StatementForm, boolean]> = (source) =>
	[source.draw(element(statementForms)), source.draw(boolean)] as const

/**
 * A description that names what no level declares, or breaks a structural rule ownership documents, each planted
 * alone into Reports, which owns as it is; and the forms the same rules admit.
 */
export type Structure =
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
	| "an extension over two bases"
	| "a value that is no description"

export const structures: Arr.NonEmptyReadonlyArray<Structure> = [
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
	"an extension over two bases",
	"a value that is no description"
]

/**
 * What ownership answers each with: success, its documented reason, or a rule the types name too, by the refusal it
 * states (Refused).
 */
export const answers: {
	readonly [S in Structure]:
		| "owned"
		| "MalformedDescription"
		| "IdentifierCollision"
		| { readonly refused: Refused }
} = {
	"Reports as written": "owned",
	"a key over an undeclared relation": {
		refused: "a statement names a relation no level of the schema declares"
	},
	"a key over an undeclared field": "MalformedDescription",
	"pred of a field that is not natural": "MalformedDescription",
	"a selection reading an undeclared field": "MalformedDescription",
	"sides of two widths": { refused: "the sides' field types differ" },
	"a closedId over an undeclared roster": "MalformedDescription",
	"a key over a closed relation": "MalformedDescription",
	"a closed relation made mutable": "MalformedDescription",
	"a check over a closed relation": "MalformedDescription",
	"a check reading a parameter": "MalformedDescription",
	"a check over its own row": "owned",
	"a family counted by no field of its owner": "MalformedDescription",
	"a family over no relation": {
		refused: "a statement names a relation no level of the schema declares"
	},
	"a derived relation in the root": "MalformedDescription",
	"a derived level that disagrees": "MalformedDescription",
	"a definition reading its own level": "MalformedDescription",
	"a parameterized definition": "MalformedDescription",
	"an extension under its base's name": "IdentifierCollision",
	"an extension over two bases": "MalformedDescription",
	"a value that is no description": "MalformedDescription"
}

/** A pool's claims, a counted family of Claim over Pool's drawn count n. */
export const Pool = relation("Pool", { id: Id, n: drawnField(natural, []) }, ["id"], [])

export const Claim = relation("Claim", { id: Id, pool: Id }, ["id"], [])

export const claimsOf = (member: string, count: string): StatementDesc => ({
	kind: "family",
	order: "counted",
	member: on(member, ["pool"]),
	slots: { owner: "Pool", count }
})
