import { everyProperty, Refusal } from "#compiler/core/canonical.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ClosedTheoryRelation, LawField } from "#compiler/ir/law.ts"
import { closedCell } from "#compiler/ir/rel.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { persistentLiteral } from "#compiler/physical/ddl/expr.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import { enforcement, lawReasons } from "#compiler/physical/obligations/graph.ts"
import type { EmittedText, Expr, ObjectName, Select } from "#compiler/sql/ast.ts"
import { cast, col, simpleSelect, targetAs } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

export interface ClosedTemplate {
	/** The closed relation whose facts it renders. */
	readonly relation: ClosedTheoryRelation
	readonly enum: ObjectName
	/** The installed column identifiers of the heading: the handle column, then the payload in declared order. */
	readonly columns: ReadonlyArray<string>
	readonly handles: ReadonlyArray<string>
	/** One typed row per handle, in roster order. */
	readonly rows: ReadonlyArray<ReadonlyArray<Expr>>
	readonly select: Select
	readonly sql: EmittedText
	/** SHA-256 over the canonical labels, column types and payload texts. */
	readonly fingerprint: string
}

/** The typed value of one fact field: its literal typed by the field's own type, a domain or the enum, as in
 * `100::plans.cents`. No persistent expression holds a domain-typed constant. */
const typedValue = (b: InstallBuilder, literal: TypedLiteral, field: LawField): Expr => {
	const t = field.type
	const value = persistentLiteral(b.names, literal, t)
	const { type } = columnType(b.names, t)
	return value.kind === "literal" ? { ...value, type } : cast(value, type)
}

const closedTemplate = (b: InstallBuilder, r: ClosedTheoryRelation): ClosedTemplate => {
	const closed = r.name
	const columns = r.fields.map((f) => b.names.column(closed, f.name))
	/** Each fact's typed values, one per field, in heading order. */
	const rows = mapNonEmpty(r.rows, (row) =>
		r.fields.map((f) => typedValue(b, closedCell(row, f.position), f))
	)
	const aliases = mapNonEmpty(r.fields, (_, i) => `c${i + 1}`)
	const select = simpleSelect(
		columns.map((column, i) => targetAs(col("r1", `c${i + 1}`), column)),
		[{ kind: "values", rows, alias: "r1", columns: aliases }],
		undefined
	)
	const emitted = emit(select, emptyNameMap)
	if (!emitted.ok) {
		throw new Refusal(emitted.error)
	}
	const fingerprint = digest(
		"closed-values-template",
		{ closed, sql: emitted.value.text },
		everyProperty
	)
	if (!fingerprint.ok) {
		throw new Refusal(fingerprint.error)
	}
	return {
		relation: r,
		enum: { schema: b.schema, name: r.ident },
		columns,
		handles: r.handles,
		rows,
		select,
		sql: emitted.value.text,
		fingerprint: fingerprint.value
	}
}

/** Every closed relation's enum, in name order, after the schema; its reasons are the containments into the roster that
 * the enum discharges (`contained` into closed facts) and the closed declaration itself.
 *
 * Closed relations: a native enum for the handles plus a typed VALUES template for the facts. The templates need every
 * domain and enum name, so they are built once every enum is planned.
 *
 * The enum is `CREATE TYPE <schema>.<closed> AS ENUM (<handles in declared order>)`: declaration order is comparison
 * order, labels are case sensitive, and a label holds at most 63 bytes (ownership refuses a longer one).
 * There is no lookup table: a closedId column is typed by the enum, so handle membership needs no FK.
 *
 * The VALUES template is a compiled artifact, not an installed object: the finite facts, one typed row per handle in
 * roster order, the handle cast to the enum and each payload value to its field's type:
 *
 *   SELECT "r1"."c1" AS "id", "r1"."c2" AS "budget"
 *   FROM (VALUES ('Free'::"plans"."tier", 100::"plans"."cents"), ('Pro'::"plans"."tier", 1000::"plans"."cents"))
 *     AS "r1"("c1", "c2")
 *
 * The canonical facts have distinct handles, so it needs no DISTINCT. Its fingerprint covers the enum labels and the
 * payload, so a payload change stales it even when the labels are unchanged. A query reads the facts as a VALUES list
 * of its own, base-typed, and casts a refined payload to its domain where it delivers it. */
export const addEnums = (
	b: InstallBuilder
): {
	readonly templates: Readonly<Record<string, ClosedTemplate>>
	/** The enums, in closed relation name order. */
	readonly enums: ReadonlyArray<ObjectName>
} => {
	const templates: Record<string, ClosedTemplate> = {}
	const enums: Array<ObjectName> = []
	for (const [name, r] of Object.entries(b.model.theory.relations).toSorted(([x], [y]) =>
		compareStrings(x, y)
	)) {
		if (r.kind !== "closed") {
			continue
		}
		const native = b.natives.filter((n) => n.object.kind === "Enum" && n.object.name === name)
		enums.push({ schema: b.schema, name: r.ident })
		b.addType(
			"enum",
			b.names.relationNamed(name),
			{
				ddl: [{ kind: "createEnum", name: { schema: b.schema, name: r.ident }, labels: r.handles }],
				reasons: [
					enforcement(`closed relation ${name}`),
					...lawReasons(native.flatMap((n) => n.object.lawIds))
				]
			},
			[b.schemaNode]
		)
	}
	for (const [name, r] of Object.entries(b.model.theory.relations).toSorted(([x], [y]) =>
		compareStrings(x, y)
	)) {
		if (r.kind === "closed") {
			templates[name] = closedTemplate(b, r)
		}
	}
	return { templates, enums }
}
