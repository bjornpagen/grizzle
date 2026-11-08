import { checkQuery } from "#compiler/check/index.ts"
import { fromJson } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { MoneyText, moneyTag, VectorText, vectorTag } from "#compiler/ir/carriers.ts"
import { DecimalText, decimalTag } from "#compiler/ir/decimal.ts"
import { decodeDesc, type DescKind, type QueryDesc } from "#compiler/ir/desc.ts"
import { schemaInfo } from "#compiler/query/build/heading.ts"
import {
	type OrderedValue,
	orderedOf,
	type QueryValue,
	queryOf
} from "#compiler/query/build/query.ts"
import { described, isOrdered, type QueryState, stageHeading } from "#compiler/query/build/state.ts"
import { type Level, levelOf } from "#compiler/schema/level.ts"
import { checkedIn } from "#test/support/policy.ts"

/** A payload its carrier parsed, or MalformedDescription where its grammar admits no such payload. */
const revived = <A>(parsed: A | undefined, literal: string): Result.Result<A, CompileError> =>
	parsed === undefined
		? Result.err(malformedDescription(SourceLoc(literal, []), "the payload's canonical text"))
		: Result.ok(parsed)

/** The revivers of the kernel carriers: each tagged payload of a Description's JSON form parsed into its carrier. */
const defaultRevivers = {
	[decimalTag]: (payload: string) => revived(DecimalText.parse(payload), "decimal literal"),
	[moneyTag]: (payload: string) => revived(MoneyText.parse(payload), "money literal"),
	[vectorTag]: (payload: string) => revived(VectorText.parse(payload), "vector literal")
} as const

/** A Description's JSON form (ir/desc.ts descToJson) back: its tagged values restored, then decoded. */
export const descFromJson = <K extends DescKind>(kind: K, json: unknown) =>
	Result.flatMap(fromJson(json, defaultRevivers), (value) => decodeDesc(kind, value))

/**
 * A QueryDescription (or any value claiming to be one, its Description in JSON form as program/describe.ts
 * describeQuery gives it) back to an owned, validated Description.
 */
export const fromQueryDescription = (
	description: unknown
): Result.Result<QueryDesc, CompileError> => descFromJson("query", description)

/** What a rebuilt query is written over: its schema's or role's level; a value that is neither is refused. */
const writtenOver = (schema: unknown): Result.Result<Level, CompileError> => {
	const level = levelOf(schema)
	return level === undefined
		? Result.err(
				malformedDescription(
					SourceLoc("query", []),
					"a schema built by schema(...) or schema.extend(...), or a role built by role(...)"
				)
			)
		: Result.ok(level)
}

/**
 * A query or ordered value rebuilt from its Description over `schema`, a schema or role value: the same combinators,
 * over a heading the Description states, typed where its descriptors say so. Its heading carries no column: it is described, and delivers no records. A
 * Description spells every name, so it waits on no attachment child.
 */
export const queryFromDesc = (
	desc: unknown,
	schema: unknown
): Result.Result<QueryValue | OrderedValue, CompileError> =>
	Result.flatMap(writtenOver(schema), (over) =>
		Result.map(decodeDesc("query", desc), (owned) => {
			const info = schemaInfo(schema, over)
			const state: QueryState = {
				desc: owned,
				heading: stageHeading(owned.stage, info.env),
				carriers: described,
				schema: info,
				pending: new Set()
			}
			return isOrdered(state) ? orderedOf(state, described) : queryOf(state, described)
		})
	)

/**
 * The inverse of describeQuery: a QueryDescription back to a query value (queryFromDesc). A value that does not decode
 * as a query's Description is MalformedDescription. A Description names relations, not the schema that declares
 * them, so the caller names the schema, which is parsed as the compiler's boundary parses it and the Description
 * checked against it.
 */
export const queryFromDescription = (
	description: unknown,
	schema: unknown
): Result.Result<QueryValue | OrderedValue, CompileError> =>
	Result.flatMap(fromQueryDescription(description), (desc) =>
		Result.flatMap(
			Result.flatMap(checkedIn(schema), (checked) =>
				checkQuery(checked, desc, {
					read: "rows",
					label: "query"
				})
			),
			() => queryFromDesc(desc, schema)
		)
	)
