import { fail } from "#compiler/check/fail.ts"
import type { MemberRelation } from "#compiler/check/schema.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { MemberDesc } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { compatible } from "#compiler/scalar/compute/types.ts"

/**
 * The fields a described member's head must deliver: the relation's heading, or for an insert that omits them, the
 * heading without its serial fields.
 */
const memberHeading = (
	relation: MemberRelation,
	op: MemberDesc["op"],
	delivered: Heading
): Heading => {
	if (op !== "insert" || relation.serial.length === 0) {
		return relation.heading
	}
	const supplied = relation.serial.filter((f) => delivered.some((c) => c.name === f))
	if (supplied.length === 0) {
		return relation.heading.filter((c) => !relation.serial.includes(c.name))
	}
	return relation.heading
}

const names = (h: Heading): string => h.map((c) => c.name).join(", ")

/**
 * The one way a member column of type `value` is written into a field of another type `field`: an exact value, which
 * no field stores, by Compute.cast under a guard that proves it fits; a value into or out of a contract by
 * Compute.cast; any other value by Compute.cast into the field's type.
 */
const writtenOnly = (value: ScalarType, field: ScalarType): string => {
	if (value.carrier === "exactInteger" || value.carrier === "exactMoney") {
		return "an exact value is written into a field only by Compute.cast under a guard that proves it fits"
	}
	if (contractOf(value) !== undefined || contractOf(field) !== undefined) {
		return "a value re-enters a contract only by Compute.cast"
	}
	return "a value is written into a field of another type only by Compute.cast"
}

/**
 * ChangeSet members described by queries.
 *
 * A member is a set of facts of one ordinary relation. An array or a Stream member is the query over a relation
 * parameter its input binds, whose shape the codec checks; a query member is checked here. Its head is the relation's
 * heading, or for an insert that heading minus all of its serial fields, which the identity default fills:
 * an addition omits either all of its relation's serial fields or none. Each head column is
 * compatible with the field it is written into: the same contract, the same roster, the same carrier;
 * the refinement itself is validated by PostgreSQL where the value is written. Anything else is
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
	op: MemberDesc["op"],
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
	const expected = memberHeading(relation, op, delivered)
	const missing = expected.filter((c) => !delivered.some((d) => d.name === c.name))
	const extra = delivered.filter((c) => !expected.some((d) => d.name === c.name))
	if (relation.serial.length > 0 && op === "insert") {
		const supplied = relation.serial.filter((f) => delivered.some((c) => c.name === f))
		if (supplied.length > 0 && supplied.length < relation.serial.length) {
			fail(
				"DescribedHeadingMismatch",
				loc,
				`an insert into ${relation.name} that omits all of its serial fields (${relation.serial.join(", ")}) or none; it supplies ${supplied.join(", ")}`
			)
		}
	}
	if (missing.length > 0 || extra.length > 0) {
		fail(
			"DescribedHeadingMismatch",
			loc,
			`a member head of ${relation.name}'s heading (${names(expected)}${op === "insert" && expected.length < relation.heading.length ? ", its serial fields omitted" : ""}), not (${names(delivered)})`
		)
	}
	for (const c of expected) {
		const d = delivered.find((x) => x.name === c.name)
		if (d !== undefined && !compatible(d.type, c.type)) {
			fail(
				"DescribedHeadingMismatch",
				loc,
				`a member column ${c.name} of ${relation.name}'s type ${typeLabel(c.type)}, not ${typeLabel(d.type)}; ${writtenOnly(d.type, c.type)}`
			)
		}
	}
}
