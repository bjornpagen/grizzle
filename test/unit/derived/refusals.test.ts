import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { checkedSchema, derivedAnalysis } from "#compiler/analysis/schema.ts"
import { type CompileError, type CompileReasonTag, isCompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { admitDerived } from "#compiler/schema/relation.ts"
import { admitCheck } from "#compiler/schema/statements.ts"
import { assert, defined } from "#test/support/assert.ts"
import * as A from "#test/support/fixtures/api/work.ts"
import {
	capacity,
	check as checkDesc,
	contained,
	field,
	ge,
	key,
	literal,
	mutable,
	on,
	type SchemaDesc,
	type AuthoredStatementDesc as StatementDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"
import { ReportsDesc, WorkDesc } from "#test/support/fixtures/ir/work.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

/** Runtime refusals for descriptions TypeScript did not check (the type tests refuse each at the type level): a
 * JavaScript caller, or a SchemaDesc decoded from data, meets the same rules at construction or at ownership, before any
 * definition is read, and so at every entry that installs or analyzes a schema.
 *
 * - No law names a derived relation, in either direction (LawOnDerived), at every entry, each law kind planted.
 * - Levels, parameters and contexts an unchecked description can still write down are refused as
 *   MalformedDescription: a materialized view reads no parameter and holds no session. */
const refusal = (r: Result.Result<unknown, CompileError>): CompileError => {
	if (r.ok) {
		throw new Error("expected a refusal")
	}
	return r.error
}

/** The Reports level with extra statements, a description no type checked. */
const withStatements = (...statements: ReadonlyArray<StatementDesc>): SchemaDesc => ({
	...ReportsDesc,
	statements: [...ReportsDesc.statements, ...statements]
})

/** A schema value owned as an entry point owns it, parsed at the public boundary first: the refusal, if any. */
const ownedOf = (schema: unknown) => ownedInput(schema)

/** Every entry that reads a schema refuses it alike. */
const refusedEverywhere = (desc: SchemaDesc, reason: CompileReasonTag) => {
	const results: ReadonlyArray<Result.Result<unknown, CompileError>> = [
		ownedOf(desc),
		Result.map(Result.flatMap(ownedOf(desc), checkedSchema), derivedAnalysis),
		Result.flatMap(ownedOf(desc), (o) =>
			compileInstallation(o, withDerivedRelations(installOptions(o, "owner")))
		)
	]
	for (const result of results) {
		assert.equal(refusal(result).reason._tag, reason)
	}
}

type LawShape =
	| "key"
	| "mutable"
	| "check"
	| "contained from it"
	| "contained into it"
	| "capacity target"
	| "capacity source"
	| "alternatives expansion"

const lawShapes: Readonly<Record<LawShape, StatementDesc>> = {
	key: key(on("AccountBudget", ["account"])),
	mutable: mutable("AccountBudget"),
	check: checkDesc("Positive", "AccountBudget", ge(field("tasks"), literal(0n))),
	"contained from it": contained(on("AccountBudget", ["account"]), on("Account", ["id"])),
	"contained into it": contained(on("Task", ["account"]), on("AccountBudget", ["account"])),
	"capacity target": capacity(
		on("AccountBudget", ["account"]),
		on("Task", ["account"]),
		within(0n, 10n),
		{
			kind: "count"
		}
	),
	"capacity source": capacity(
		on("Account", ["id"]),
		on("AccountBudget", ["account"]),
		within(0n, 10n),
		{
			kind: "count"
		}
	),
	/** An alternatives expansion naming a derived relation, by its origin marker. */
	"alternatives expansion": {
		kind: "contained",
		left: on("AccountBudget", ["account"]),
		right: on("Kind", ["id"]),
		origin: { alternatives: "AccountBudget.account" }
	}
}

/** A description an unchecked caller can still write down, planted, each refused as MalformedDescription. */
type Unwritable =
	| "a derived relation in a root schema"
	| "a definition that reads its own level"
	| "a parameterized definition"
	| "a definition that matches a context"
const budget = ReportsDesc.relations[0]
/** AccountBudget's definition with a context matched in its first arm: a session's claim no materialized view holds. */
const contextual = (): unknown => {
	const b = defined(budget, "AccountBudget")
	if (b.kind !== "derived" || b.query.stage.kind !== "rules") {
		throw new Error("AccountBudget's rules")
	}
	const [first, ...rest] = b.query.stage.arms
	const session = { name: "Session", fields: { sub: { kind: "uuid" as const } }, claim: undefined }
	const arm = {
		...first,
		matches: [
			...first.matches,
			{ ...first.matches[0], source: { kind: "context" as const, context: session }, bindings: {} }
		]
	}
	return {
		...ReportsDesc,
		relations: [{ ...b, query: { stage: { ...b.query.stage, arms: [arm, ...rest] } } }]
	}
}

const budgetCopy = {
	kind: "derived" as const,
	name: "BudgetCopy",
	level: 2,
	query: {
		stage: {
			kind: "rules" as const,
			arms: [
				{
					vars: [{ id: "account", origin: { relation: "AccountBudget", field: "account" } }],
					matches: [
						{
							source: { kind: "relation" as const, name: "AccountBudget" },
							bindings: { account: { kind: "var" as const, var: "account" } }
						}
					],
					where: [],
					head: { account: { kind: "var" as const, var: "account" } },
					interiors: [],
					attach: []
				}
			]
		}
	}
}

const tasksOf = query(A.Work).rule((r) => {
	const { id } = v(A.Task, "task")
	return r.match(A.Task, { id, account: r.param("account", A.Task.fields.account) }).find({ id })
})

const parameterized = (): unknown => {
	const D = derived(
		"Plain",
		query(A.Work).rule((r) => {
			const { id } = v(A.Task, "task")
			return r.match(A.Task, { id }).find({ id })
		})
	)
	const owned = ownedOf(schema.extend(A.Work, { Plain: D }, []))
	if (!owned.ok) {
		throw owned.error
	}
	const plainDesc = owned.value.relations["Plain"]?.desc
	if (plainDesc?.kind !== "derived") {
		throw new Error("D")
	}
	return { ...ReportsDesc, relations: [{ ...plainDesc, query: queryValueDesc(tasksOf) }] }
}

const unwritable = (shape: Unwritable): unknown => {
	switch (shape) {
		case "a derived relation in a root schema":
			return { ...WorkDesc, relations: [...WorkDesc.relations, ...ReportsDesc.relations] }
		case "a definition that reads its own level":
			return { ...ReportsDesc, relations: [defined(budget, "AccountBudget"), budgetCopy] }
		case "a parameterized definition":
			return parameterized()
		case "a definition that matches a context":
			return contextual()
	}
}

describe("derived relation refusals", () => {
	it.effect(
		"refuse every law naming a derived relation, in either direction, at every entry",
		(ctx) =>
			Effect.gen(function* () {
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/derived/law-on-derived",
							generator: element<LawShape>([
								"key",
								"mutable",
								"check",
								"contained from it",
								"contained into it",
								"capacity target",
								"capacity source",
								"alternatives expansion"
							]),
							literal: Formatter.format,
							limit: 8,
							coverage: requiredInSpace<LawShape>([
								"key",
								"mutable",
								"check",
								"contained from it",
								"contained into it",
								"capacity target",
								"capacity source",
								"alternatives expansion"
							]),
							caseHang
						},
						(shape, c) =>
							Effect.sync(() => {
								c.note(shape)
								refusedEverywhere(withStatements(lawShapes[shape]), "LawOnDerived")
							})
					)
				)
				/** The builder's check refuses a derived relation at construction, before its callback runs. */
				let called = false
				assert.throws(
					() =>
						admitCheck("Positive", A.AccountBudget, () => {
							called = true
							return undefined
						}),
					(e) => isCompileError(e) && e.reason._tag === "LawOnDerived"
				)
				assert.equal(called, false)
			})
	)

	it.effect(
		"refuse a level, parameter or context an unchecked description can still write down",
		(ctx) =>
			Effect.gen(function* () {
				const shapes = [
					"a derived relation in a root schema",
					"a definition that reads its own level",
					"a parameterized definition",
					"a definition that matches a context"
				] as const
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/derived/unwritable",
							generator: element<Unwritable>([...shapes]),
							literal: Formatter.format,
							limit: 4,
							coverage: requiredInSpace<Unwritable>(shapes),
							caseHang
						},
						(shape, c) =>
							Effect.sync(() => {
								c.note(shape)
								assert.equal(
									refusal(ownedOf(unwritable(shape))).reason._tag,
									"MalformedDescription"
								)
							})
					)
				)
				assert.throws(
					() => admitDerived("TasksOf", tasksOf, []),
					(e) => isCompileError(e) && e.reason._tag === "MalformedDescription"
				)
			})
	)
})
