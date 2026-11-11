import { Array as Arr, Option, Record as Rec } from "effect"
import type { ExecutionInputs } from "#adapter/reader/execution.ts"
import type { ParamCodecs } from "#adapter/reader/relations.ts"
import { admittedIdentifier, defect, type RouteKey } from "#compiler/plan/runtime.ts"
import type { ServedFootprint } from "#compiler/plan/serve.ts"

/**
 * A layer's routing index: each live subscription under the routing keys it registered, so a key its change source
 * delivers (live/source.ts) reaches exactly the subscriptions the change may have changed. A keyed key (table, column,
 * value) reaches every subscription registered at that very key and every one that reads the table whole; a table key
 * reaches every subscription of the table. The index is the registry's explicit state (live/subscriptions.ts), changed
 * only by registering and deregistering, and keeps no empty bucket, so its size follows the subscriptions registered and
 * never the changes routed.
 *
 * The subscriptions of one table: those that read it whole (`wide`), and those registered at a routed column's bound
 * value (`keyed`, by column, then by value).
 */
interface TableRoutes<S> {
	readonly wide: Set<S>
	readonly keyed: Map<string, Map<string, Set<S>>>
}

/** The index: each table's subscriptions, by the table's installed name, as the change source names it. */
export type RouteIndex<S> = Map<string, TableRoutes<S>>

/** The routes of `table`, made empty when the index holds none. */
const tableRoutes = <S>(index: RouteIndex<S>, table: string): TableRoutes<S> => {
	const held = index.get(table)
	if (held !== undefined) {
		return held
	}
	const made: TableRoutes<S> = { wide: new Set(), keyed: new Map() }
	index.set(table, made)
	return made
}

/** The subscriptions at `value` among `values`, made empty when none is held. */
const valueSubscriptions = <S>(values: Map<string, Set<S>>, value: string): Set<S> => {
	const held = values.get(value)
	if (held !== undefined) {
		return held
	}
	const made = new Set<S>()
	values.set(value, made)
	return made
}

/** The values of `column` among `keyed`, made empty when none is held. */
const columnValues = <S>(
	keyed: Map<string, Map<string, Set<S>>>,
	column: string
): Map<string, Set<S>> => {
	const held = keyed.get(column)
	if (held !== undefined) {
		return held
	}
	const made = new Map<string, Set<S>>()
	keyed.set(column, made)
	return made
}

/** `subscription` registered under each of `keys`; a key it already holds holds it once. */
export const addRoutes = <S>(
	index: RouteIndex<S>,
	subscription: S,
	keys: ReadonlyArray<RouteKey>
): void => {
	for (const key of keys) {
		const routes = tableRoutes(index, key.table)
		switch (key.kind) {
			case "table":
				routes.wide.add(subscription)
				break
			case "keyed":
				valueSubscriptions(columnValues(routes.keyed, key.column), key.value).add(subscription)
				break
		}
	}
}

/** `subscription` deregistered from each of `keys`, every bucket it leaves empty dropped with it. */
export const removeRoutes = <S>(
	index: RouteIndex<S>,
	subscription: S,
	keys: ReadonlyArray<RouteKey>
): void => {
	for (const key of keys) {
		const routes = index.get(key.table)
		if (routes === undefined) {
			continue
		}
		switch (key.kind) {
			case "table":
				routes.wide.delete(subscription)
				break
			case "keyed": {
				const values = routes.keyed.get(key.column)
				const subscriptions = values?.get(key.value)
				if (values === undefined || subscriptions === undefined) {
					break
				}
				subscriptions.delete(subscription)
				if (subscriptions.size === 0) {
					values.delete(key.value)
				}
				if (values.size === 0) {
					routes.keyed.delete(key.column)
				}
				break
			}
		}
		if (routes.wide.size === 0 && routes.keyed.size === 0) {
			index.delete(key.table)
		}
	}
}

/**
 * Each subscription `key` reaches (see the header) handed to `visit`, with no allocation: one registered under several
 * keys the key reaches is handed once for each, which a visit that marks it reads as once.
 */
export const route = <S>(
	index: RouteIndex<S>,
	key: RouteKey,
	visit: (subscription: S) => void
): void => {
	const routes = index.get(key.table)
	if (routes === undefined) {
		return
	}
	for (const subscription of routes.wide) {
		visit(subscription)
	}
	switch (key.kind) {
		case "table":
			for (const values of routes.keyed.values()) {
				for (const subscriptions of values.values()) {
					for (const subscription of subscriptions) {
						visit(subscription)
					}
				}
			}
			return
		case "keyed": {
			const subscriptions = routes.keyed.get(key.column)?.get(key.value)
			if (subscriptions === undefined) {
				return
			}
			for (const subscription of subscriptions) {
				visit(subscription)
			}
			return
		}
	}
}

/**
 * The routing keys a read's subscription registers under, from its served footprint (served/forms.ts ServedFootprint)
 * and the inputs one execution of it admitted: each table it reads whole is a table key, and each routed column of any
 * other is a key at the text its parameter's codec encoded, which the routable carriers spell as PostgreSQL's output
 * text of the same value, the text a change's key holds (engine live/notify.ts RouteKey). The footprint's tables and columns
 * are the installed identifiers the served file holds, admitted as read. A footprint names a routed column's
 * parameter by its declared name, a scalar parameter of the read whose encoded input is text: any other is a defect of
 * the generate that served it.
 */
export const routeKeys = (
	footprint: ServedFootprint,
	codecs: ParamCodecs,
	inputs: ExecutionInputs
): ReadonlyArray<RouteKey> => {
	const keys: Array<RouteKey> = []
	for (const [table, routes] of Rec.toEntries(footprint)) {
		const columns = Rec.toEntries(routes)
		if (!Arr.isReadonlyArrayNonEmpty(columns)) {
			keys.push({ kind: "table", table: admittedIdentifier<"table">(table) })
			continue
		}
		for (const [column, param] of columns) {
			const codec = Arr.findFirst(codecs, (c) => c.decl.name === param)
			const text =
				Option.isSome(codec) && codec.value.kind === "scalar"
					? inputs.scalars.get(codec.value.decl.id)
					: undefined
			if (typeof text !== "string") {
				throw defect(
					`the route of ${table}.${column} names ${param}, a scalar parameter of its read encoded as text`
				)
			}
			keys.push({
				kind: "keyed",
				table: admittedIdentifier<"table">(table),
				column: admittedIdentifier<"column">(column),
				value: text
			})
		}
	}
	return keys
}
