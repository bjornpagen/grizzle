import { compareText } from "#compiler/core/canonical.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { bytesMaxLength } from "#compiler/core/limits.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import type { Expr, InlineConstraint } from "#compiler/sql/ast.ts"
import { binary, call, lit, tableCol, types } from "#compiler/sql/build.ts"

/** A bytes column's length CHECK: its relation and field, its identity, and the constraint its table declares. */
interface BytesLength {
	readonly relation: string
	readonly field: string
	readonly named: Identity<"bytesCheck">
	readonly constraint: InlineConstraint
}

/** The length predicate over the unqualified column `column`, as a row CHECK spells it. */
const lengthPredicate = (column: Expr): Expr =>
	binary("<=", call("octet_length", [column]), lit.int(bytesMaxLength.value, types.integer))

const bytesColumns = (heading: ReadonlyArray<HeadingColumn>): ReadonlyArray<HeadingColumn> =>
	heading.filter((c) => c.type.carrier === "bytes")

/**
 * The length CHECK of every bytes column of every stored relation, in relation then field order, for its table's
 * CREATE TABLE to declare (`addBytesLengths` adds their objects once the tables stand).
 *
 * `bytes` is PostgreSQL's bytea, whose column is `pg_catalog.bytea NOT NULL`. A bytea holds up to a gigabyte, but its
 * hex text, which grizzle reads every result cell as, is one string only up to core/limits.ts bytesMaxLength bytes, so
 * the column carries the named CHECK of that bound:
 *
 *     CONSTRAINT "__file_length_body_<digest>"
 *       CHECK ((pg_catalog.octet_length("body") <= 268435443::integer) IS TRUE)
 *
 * octet_length of a bytea reads its length word, never its bytes. The CHECK is declared inline by the table's CREATE
 * TABLE beside the row's other CHECKs, and PostgreSQL enforces it on every write, grizzle's or a direct SQL writer's. It
 * is the range of the field's type, not a law of the schema: it has no law id and no witness, and grizzle's own writes
 * meet the codec's host boundary first, which refuses a longer value as bytesLength, so it refuses only a direct
 * writer. Its name is the naming door's hashed bytesCheck, which no declared check of the relation can claim.
 */
export const bytesLengths = (b: InstallBuilder): ReadonlyArray<BytesLength> =>
	Object.entries(b.model.theory.relations)
		.toSorted(([x], [y]) => compareText(x, y))
		.flatMap(([name, r]) =>
			r.kind === "relation"
				? bytesColumns(r.fields).map((c): BytesLength => {
						const named = identity.bytesCheck(name, c.name)
						return {
							relation: name,
							field: c.name,
							named,
							constraint: {
								kind: "check",
								name: b.name(named),
								predicate: lengthPredicate(tableCol(b.names.column(name, c.name)))
							}
						}
					})
				: []
		)

/** Each length CHECK's object, which its table declares inline, so it carries no statement: after its table. */
export const addBytesLengths = (b: InstallBuilder, lengths: ReadonlyArray<BytesLength>): void => {
	for (const l of lengths) {
		b.add(
			{
				kind: "check",
				ident: {
					kind: "constraint",
					schema: b.settings.installation,
					relation: b.names.relationNamed(l.relation),
					name: l.named
				},
				ddl: [],
				reasons: [
					enforcement(
						`the bytes whose hex text one string holds of ${l.relation}.${l.field}: at most ${bytesMaxLength.value}`
					)
				],
				phase: "structure"
			},
			[b.table(l.relation)]
		)
	}
}
