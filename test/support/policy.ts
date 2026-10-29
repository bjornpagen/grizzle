import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { checkMember, type CheckOptions, checkReadBack } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { checkedInput, parseSchemaInput } from "#compiler/program/schema.ts"
import { type Owned, own } from "#compiler/schema/own.ts"
import {
	decodedMember,
	decodedReadBack,
	type MemberDesc,
	type ReadBackDesc
} from "#test/support/fixtures/ir/desc.ts"

/**
 * A schema owned, or read by the checker: what a compilation's entry point does first, the schema parsed at the public
 * boundary (program/schema.ts parseSchemaInput), so a test hands the compiler what production hands it. A role is
 * owned as its base, reality, and checked as itself. A schema that does not parse or own is a defect of the test here;
 * a test of ownership's refusals calls own itself.
 *
 * The owned reality of a schema value, a role's base, or a SchemaDesc, as the compiler's boundary parses it.
 */
export const ownedInput = (schema: unknown): Result.Result<Owned, CompileError> =>
	Result.flatMap(parseSchemaInput(schema), (input) =>
		own(input.kind === "role" ? input.desc.base : input.desc)
	)

/** The value of a step the test states must succeed; its refusal, thrown, is a defect of the test. */
const orThrow = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw result.error
	}
	return result.value
}

export const owning = (schema: unknown): Owned => orThrow(ownedInput(schema))

/** The SchemaDesc of a schema value, a role's base, an owned schema or a SchemaDesc, as the compiler's boundary parses it. */
export const schemaDescIn = (schema: unknown): Result.Result<SchemaDesc, CompileError> =>
	Result.map(parseSchemaInput(schema), (input) =>
		input.kind === "role" ? input.desc.base : input.desc
	)

/** The checked schema of a schema value, or the compiler's refusal of it: its derived relations' analysis among them. */
export const checkedIn = (schema: unknown): Result.Result<CheckedSchema, CompileError> =>
	Result.flatMap(parseSchemaInput(schema), checkedInput)

export const checking = (schema: unknown): CheckedSchema => orThrow(checkedIn(schema))

/**
 * The check options an entry point states for a query read as rows: a fresh meter over production's budgets, and the
 * query's label.
 */
export const checkOptions = (label: string): CheckOptions => ({
	read: "rows",
	meter: new BudgetMeter(compileBudgets),
	label
})

/**
 * A member described by a query and a read-back, checked as the write frontend checks them, each labelled by what it
 * is. The member is authored to be decoded, and is decoded inside its ChangeSet, as the write frontend receives it; its
 * relation is an ordinary relation of the schema, resolved by its name as the front end resolves it.
 */
export const checkMemberOf = (
	checked: CheckedSchema,
	member: MemberDesc,
	extra: Partial<CheckOptions>
): Result.Result<LogicalQuery, CompileError> => {
	const decoded = decodedMember(member)
	const source = decoded.member
	if (source.kind !== "query") {
		throw new Error("a member described by a query")
	}
	const relation = checked.relations.get(decoded.relation)
	if (relation === undefined) {
		throw new Error(`a member of an ordinary relation of the schema, not ${decoded.relation}`)
	}
	return checkMember(
		checked,
		{ op: decoded.op, relation, query: source.query, loc: decoded.loc },
		{ ...checkOptions(`${member.op} ${member.relation}`), ...extra }
	)
}

export const checkReadBackOf = (
	checked: CheckedSchema,
	readBack: ReadBackDesc,
	extra: Partial<CheckOptions>
): Result.Result<LogicalQuery, CompileError> =>
	checkReadBack(checked, decodedReadBack(readBack), {
		...checkOptions(`read ${readBack.name}`),
		...extra
	})
