import type { Identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { generationOf } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { closedSubset } from "#compiler/physical/closed/storage.ts"
import { dateRange } from "#compiler/physical/date/storage.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { boundedNumeric, exactNumeric, integerNumeric } from "#compiler/physical/numeric/storage.ts"
import { enforcement } from "#compiler/physical/obligations/graph.ts"
import { vectorNorm } from "#compiler/physical/vector/storage.ts"
import type { Expr, InlineConstraint } from "#compiler/sql/ast.ts"
import { tableCol } from "#compiler/sql/build.ts"

/** The identities of the column CHECKs (ColumnCheckKind), one kind each. */
type ColumnCheckIdentity = Identity<
	"normCheck" | "dateCheck" | "integerCheck" | "exactCheck" | "boundCheck" | "subsetCheck"
>

/**
 * One kind of a stored column's CHECK of the values its host type or its bound spells, where PostgreSQL's type holds
 * more: the
 * columns it holds of, by their type; its identity, the naming door's hashed one, which no declared check of the
 * relation can claim; its predicate over the unqualified column of the type, as a row CHECK spells it; and the reason
 * its object carries.
 */
interface ColumnCheckKind {
	readonly holds: (type: ScalarType) => boolean
	/**
	 * Whether a field PostgreSQL generates, or a key generation its row CHECK holds equal to its generation, is a value
	 * the CHECK admits wherever the analysis admitted its generation (analysis/schema.ts generatedTypeRule): such a
	 * column carries none, since a check the compile proves emits nothing.
	 */
	readonly generationProves: boolean
	readonly named: (relation: string, field: string) => ColumnCheckIdentity
	readonly predicate: (b: InstallBuilder, column: Expr, type: ScalarType) => Expr
	readonly reason: (relation: string, field: string, type: ScalarType) => string
}

/** One column's CHECK: its relation and field, its identity, the constraint its table declares, and its reason. */
interface ColumnCheck {
	readonly relation: string
	readonly field: string
	readonly named: ColumnCheckIdentity
	readonly constraint: InlineConstraint
	readonly reason: string
}

/**
 * The column CHECKs, in the order a table declares them: a vector's cosine domain (physical/vector/storage.ts), a
 * date's days (physical/date/storage.ts), an integer numeric's integers, an exact field's values at its scale and a
 * computed numeric's bound
 * (physical/numeric/storage.ts), and a closed id subset's codes (physical/closed/storage.ts).
 */
const kinds: ReadonlyArray<ColumnCheckKind> = [
	vectorNorm,
	dateRange,
	integerNumeric,
	exactNumeric,
	boundedNumeric,
	closedSubset
]

/**
 * The CHECK of every column of every stored relation each kind holds of, kind by kind, each in relation then field
 * order, for its table's CREATE TABLE to declare (`addColumnChecks` adds their objects once the tables stand). Each is
 * declared inline beside the row's other CHECKs, and PostgreSQL enforces it on every write, grizzle's or a direct SQL
 * writer's. It is the field type's own, not a law of the schema: it has no law id and no witness, and grizzle's own
 * writes meet the codec's host boundary first, which admits only the values the host type spells, so it refuses only a
 * direct writer. A field whose generation proves its kind's CHECK carries none (ColumnCheckKind generationProves).
 */
export const columnChecks = (b: InstallBuilder): ReadonlyArray<ColumnCheck> => {
	const relations = Object.entries(b.model.theory.relations).toSorted(([x], [y]) =>
		compareStrings(x, y)
	)
	return kinds.flatMap((kind) =>
		relations.flatMap(([name, r]) =>
			r.kind === "relation"
				? r.fields
						.filter(
							(c) => kind.holds(c.type) && !(kind.generationProves && generationOf(c) !== undefined)
						)
						.map((c): ColumnCheck => {
							const named = kind.named(name, c.name)
							return {
								relation: name,
								field: c.name,
								named,
								constraint: {
									kind: "check",
									name: b.name(named),
									predicate: kind.predicate(b, tableCol(b.names.column(name, c.name)), c.type)
								},
								reason: kind.reason(name, c.name, c.type)
							}
						})
				: []
		)
	)
}

/** Each column CHECK's object, which its table declares inline, so it carries no statement: after its table. */
export const addColumnChecks = (b: InstallBuilder, checks: ReadonlyArray<ColumnCheck>): void => {
	for (const c of checks) {
		b.add(
			{
				kind: "check",
				ident: {
					kind: "constraint",
					schema: b.names.levelOf(c.relation),
					relation: b.names.relationNamed(c.relation),
					name: c.named
				},
				ddl: [],
				reasons: [enforcement(c.reason)],
				phase: "structure"
			},
			[b.table(c.relation)]
		)
	}
}
