import { fail } from "#compiler/check/fail.ts"
import type { MemberColumn, MemberRelation } from "#compiler/check/schema.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	isExactValue,
	isNumericValue,
	type ScalarType,
	entersColumn,
	typeLabel
} from "#compiler/ir/scalar.ts"

/**
 * Whether a member that adds facts writes a field written so: a caller's field, and an instant, which its rows state
 * from a stored instant or leave out to be stamped; never one PostgreSQL generates, grizzle draws or accumulates, or
 * its insert places (types/changeset UnwrittenFieldsOf).
 */
const memberWrites = (writing: MemberColumn["writing"]["kind"]): boolean => {
	switch (writing) {
		case "caller":
		case "instant":
			return true
		case "generated":
		case "keyGenerated":
		case "drawn":
		case "accumulated":
		case "place":
			return false
	}
}

/**
 * The fields of a member's relation a member writes (memberWrites), in heading order: the relation's one fact heading
 * (rule 0), every op's, so a fact deleted and added is one fact, and a field-equality member's head
 * (write/frontend/equal.ts). A generated, drawn or accumulated field is a function of the written ones or grizzle's, so
 * no delete matches on it.
 */
export const writtenHeading = (relation: MemberRelation): Heading =>
	relation.heading.filter((c) => memberWrites(c.writing.kind))

const names = (h: Heading): string => h.map((c) => c.name).join(", ")

/** What a member's expected heading leaves out of its relation's, as its refusal names it. */
const omitted = (relation: MemberRelation): string =>
	relation.heading.some((c) => !memberWrites(c.writing.kind))
		? ", the fields grizzle or PostgreSQL writes omitted"
		: ""

/**
 * The one way a member column of type `value` is written into a field of another type `field`: an exact value as it is
 * into an exact field of its carrier (exactInteger, exactMoney), and into any other, as a computed numeric into any
 * field, by Type.cast under a guard that proves it fits; a value into or out of a contract by Type.cast; any other
 * value, of another numeric typmod or span width among them, by Type.cast into the field's type.
 */
const writtenOnly = (value: ScalarType, field: ScalarType): string => {
	if (isExactValue(value)) {
		return `an exact value is written as it is into an exact field of its carrier, ${value.carrier}, and into any other field only by Type.cast under a guard that proves it fits`
	}
	if (isNumericValue(value)) {
		return "a computed numeric is written into a field only by Type.cast under a guard that proves it fits"
	}
	if (value.contract !== undefined || field.contract !== undefined) {
		return "a value re-enters a domain only by Type.cast"
	}
	return "a value is written into a field of another type only by Type.cast"
}

/**
 * ChangeSet members described by queries.
 *
 * A member is a set of facts of one ordinary relation. An array member is the query over a relation
 * parameter its input binds, whose shape the codec checks; a query member is checked here. A delete's head is the
 * relation's heading; an insert's and a put's is the fields a member writes, no field PostgreSQL generates or grizzle
 * draws or accumulates, an instant left out or stated (write/frontend/instants.ts). Each head column enters the field it is
 * written into at the field's own type (ir/scalar.ts entersColumn), as a generated field's term and a fold's
 * accumulator do: the same carrier, contract, roster, numeric typmod, span endpoint and width, and vector dimensions,
 * an exact value only into an exact field of its carrier, never a computed numeric, which no field stores, and a closed
 * id's subset within the field's; a
 * text's pattern and byte bound alone are the column's domain's, which PostgreSQL validates where the value is written. Anything else is
 * DescribedHeadingMismatch, located at the member. An attachment on the member's result is a field too,
 * one an Attach node's heading does not list: the checker refuses it where it is attached (checker.ts attach).
 *
 * A literal or parameter the head writes takes the type of its field and is cast to the field's domain where it is
 * written: the checker types the member's own rules against the target relation (checker.ts
 * MemberTarget). The relation is what a member is checked against (check/schema.ts MemberRelation): an ordinary
 * relation's, or a role's writable query entry's, which the write front end resolves by the member's name, refusing a
 * closed or derived relation, which no ChangeSet writes.
 *
 * Refuses a member query whose result is not the relation's heading (DescribedHeadingMismatch).
 */
export const checkMemberHeading = (
	query: LogicalQuery,
	relation: MemberRelation,
	loc: SourceLoc
): void => {
	const root = query.dag.roots[0]
	if (root.kind === "Union" && root.groups.length > 1) {
		fail(
			"DescribedHeadingMismatch",
			loc,
			`a member of ${relation.name} with one heading; its arms deliver ${root.groups.length} headings`
		)
	}
	const delivered = root.heading
	const expected = writtenHeading(relation)
	/** An instant a head leaves out is the write's to stamp or to refuse, by its op and its role (write/frontend/
	 * instants.ts stampsOf); one it states is held to the instant's type, which only a stored instant is. */
	const instants = new Set(
		relation.heading.flatMap((c) => (c.writing.kind === "instant" ? [c.name] : []))
	)
	const missing = expected.filter(
		(c) => !instants.has(c.name) && !delivered.some((d) => d.name === c.name)
	)
	const extra = delivered.filter((c) => !expected.some((d) => d.name === c.name))
	if (missing.length > 0 || extra.length > 0) {
		fail(
			"DescribedHeadingMismatch",
			loc,
			`a member head of ${relation.name}'s heading (${names(expected)}${omitted(relation)}), not (${names(delivered)})`
		)
	}
	for (const c of expected) {
		const d = delivered.find((x) => x.name === c.name)
		if (d !== undefined && !entersColumn(c.type, d.type)) {
			fail(
				"DescribedHeadingMismatch",
				loc,
				`a member column ${c.name} of ${relation.name}'s type ${typeLabel(c.type)}, not ${typeLabel(d.type)}; ${writtenOnly(d.type, c.type)}`
			)
		}
	}
}
