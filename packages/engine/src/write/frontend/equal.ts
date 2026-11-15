import { writtenHeading } from "#compiler/check/member.ts"
import type { MemberRelation } from "#compiler/check/schema.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import { CompileError, prose } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type { EqualedDesc, ExprDesc, QueryDesc } from "#compiler/ir/desc.ts"

/** The scope a field-equality member's variables are minted in, as `v(R, "equal")` mints them. */
const scope = "equal"

/** What a field equals, as an operand opposite its variable: its parameter, or its literal, which the checker types by
 * the field's column, as it types a head literal. */
const operand = (e: EqualedDesc): ExprDesc =>
	e.kind === "param"
		? { kind: "param", name: e.name, type: e.type }
		: { kind: "literal", value: e.value }

/**
 * The query a field-equality member of `relation` is: the facts of the relation as its member writes them, each field of
 * its written heading (check/member.ts writtenHeading) a variable of its match and its head, kept where each field
 * `fields` names equals what it equates it to, each in the heading's order, so the record's order is no part of it,
 *
 *   query(S).rule((r) => { const equal = v(R, "equal"); return r.match(R, equal).where(r.eq(equal.f, p), …).find(equal) })
 *
 * so the planner holds it as the query member it is: an anchored deletion (write/delete/anchor.ts), DELETE FROM R WHERE
 * f = $1 AND …, where it is a delete, and every refusal, family, unit, rule and certification path a query member
 * meets. `relation` is the member's relation as the write front end resolves it, a tree's root fields for a tree's
 * delete and a query entry's facts through one. A field outside its written heading names nothing a fact of the member
 * states and is refused.
 */
export const equalQuery = (
	relation: MemberRelation,
	fields: Readonly<Record<string, EqualedDesc>>,
	loc: SourceLoc
): QueryDesc => {
	const heading = writtenHeading(relation)
	const names = heading.map((c) => c.name)
	const stray = Object.keys(fields).find((f) => !names.includes(f))
	if (stray !== undefined) {
		throw new Refusal(
			CompileError.make(
				prose(
					"MalformedDescription",
					childLoc(loc, stray),
					`a field-equality member of ${relation.name} names fields its facts state (${names.join(", ")}); ${stray} is none of them`
				)
			)
		)
	}
	const id = (field: string): string => `${scope}.${field}`
	const variable = (field: string): ExprDesc => ({ kind: "var", var: id(field) })
	return {
		stage: {
			kind: "rules",
			loc,
			arms: [
				{
					loc,
					vars: names.map((field) => ({
						id: id(field),
						origin: { relation: relation.name, field },
						loc: childLoc(loc, field)
					})),
					matches: [
						{
							loc,
							source: { kind: "relation", name: relation.name },
							bindings: Object.fromEntries(names.map((field) => [field, variable(field)]))
						}
					],
					where: names.flatMap((field): ReadonlyArray<ExprDesc> => {
						const e = fields[field]
						return e === undefined
							? []
							: [{ kind: "compare", op: "eq", left: variable(field), right: operand(e) }]
					}),
					head: Object.fromEntries(names.map((field) => [field, variable(field)])),
					interiors: [],
					attach: []
				}
			]
		}
	}
}
