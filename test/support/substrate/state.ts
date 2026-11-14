import { Array as Arr, Effect, Record as Rec, Result } from "effect"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { describeField } from "#compiler/scalar/registry.ts"
import type { CarrierHost } from "#compiler/scalar/values/identity.ts"
import { namedRelation } from "#compiler/schema/relation.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { type StrictFault, strictReader } from "#test/support/kernel/strict.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** One stored row of an installed relation, by declared field name, every cell read strictly by its field's type. */
export type StateValue = CarrierHost[Carrier]
export type StateRow = { readonly [field: string]: StateValue }

interface Column {
	readonly field: string
	readonly select: string
	/** The column's output text read strictly by the field's type, a closed id's under the installation's codes. */
	readonly read: (text: string) => Result.Result<StateValue, StrictFault>
}

/** The relation's fields, each with its column type and its select-list item: a drawn, accumulated or generated
 * field read by the descriptor of its declared type, as the relation's own reading types it. */
const columnsOf = (
	installed: Installed,
	relation: AnyRelation
): Effect.Effect<ReadonlyArray<Column>> =>
	Effect.gen(function* () {
		const named = namedRelation(relation, relation.name)
		if (named.kind !== "relation") {
			return yield* Effect.die(new Error(`${relation.name} is no stored relation of fields`))
		}
		const columns: Array<Column> = []
		for (const [field, descriptor] of Rec.toEntries(named.descriptors)) {
			const described = describeField(descriptor, SourceLoc(`${relation.name}.${field}`, []))
			if (!described.ok) {
				return yield* Effect.die(described.error)
			}
			const type = described.value.scalar
			const casts = Arr.join(
				Arr.map(resultTextCasts(type), (c) => `::${c}`),
				""
			)
			columns.push({
				field,
				select: `${quoteIdent(installed.names.column(relation.name, field))}${casts}`,
				read: strictReader(type, installed.names.codes)
			})
		}
		return columns
	})

/**
 * The stored state of an installed relation, read as the owner: every row of its table, by declared field name, each
 * cell its column's output text read strictly by the field's own type (test/support/kernel/strict.ts), a closed id's
 * code under the installation's codes as the handle it names.
 *
 * The table and its columns are the installation's own names (Installed.names), the authority the lowerings emit, so a
 * test never spells or re-derives one. A row grizzle stored that the strict reader refuses is a defect, never a value,
 * and so is a NULL cell: no field of an installed relation is nullable. The rows come in the server's order, which a
 * heap does not fix: callers compare them by `find`/`filter`, or as sets (@bjornpagen/testing/oracle `set(structuralHash, exact)`,
 * which fails on a repeated row), never by position.
 *
 * Every stored row of `relation` in `installed`, read as the owner.
 */
export const tableState = (
	installed: Installed,
	relation: AnyRelation
): Effect.Effect<ReadonlyArray<StateRow>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const columns = yield* columnsOf(installed, relation)
		const table = printObjectName(installed.names.relation(relation.name))
		const rows = yield* s.admin.queryValues(
			`SELECT ${Arr.join(
				Arr.map(columns, (c) => c.select),
				", "
			)} FROM ${table}`,
			[]
		)
		const state: Array<StateRow> = []
		for (const row of rows) {
			const entries: Array<readonly [string, StateValue]> = []
			for (const [i, column] of columns.entries()) {
				const cell = row[i]
				if (typeof cell !== "string") {
					return yield* Effect.die(
						new Error(
							`${relation.name}.${column.field}: a stored cell is ${cell === null ? "NULL" : typeof cell}`
						)
					)
				}
				const read = column.read(cell)
				if (Result.isFailure(read)) {
					return yield* Effect.die(new Error(`${relation.name}.${column.field}: ${read.failure}`))
				}
				entries.push([column.field, read.success])
			}
			state.push(Rec.fromEntries(entries))
		}
		return state
	})
