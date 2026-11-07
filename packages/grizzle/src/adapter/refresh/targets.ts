import { Array as Arr, Order, Predicate, Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import {
	admitDerived,
	catchCompileError,
	CompileError,
	derivedDraftOf,
	descText,
	malformedDescription,
	type ObjectName,
	ownedKind,
	type QueryDesc,
	type RoleDesc,
	type SchemaArtifacts,
	type SchemaDesc,
	SourceLoc
} from "#compiler/plan/common.ts"
import { hostArguments } from "#compiler/plan/read.ts"

/**
 * Which views one db.refresh call refreshes, and in which order.
 *
 * `db.refresh(...relations)` names derived relation values. Before any SQL, each value is resolved against the base of
 * the role the Db was opened for:
 *
 * - it must be a derived relation, built by derived(...): any other value, which the types already forbid, is
 *   MalformedDescription;
 * - it must be a derived relation of the base, under its name and with the very definition the base declares: a name
 *   the base does not declare as a derived relation, or a definition that differs from the declared one, is
 *   MalformedDescription;
 * - it must be in the role's refresh list: the type RefreshListOf<R> already requires it, and a value that breaks it is
 *   refused with OutsideRole, as a ChangeSet outside the write list is (write/frontend/compile.ts). PostgreSQL would
 *   refuse it again, because the role holds no MAINTAIN on the view.
 *
 * The refresh's error channel is ApplyError, which carries no CompileError, so the caller reports a refusal as the
 * ExecutionFailure whose reason is the CompileError, exactly as an apply reports a ChangeSet that does not compile.
 *
 * Order. One refresh statement per named relation in level order, relations at one level in declared order. A level
 * is a level of schema extension: the root schema is level 0 and its n-th
 * schema.extend is level n, and declared order is the order the relations are written in that schema.extend's record.
 * A definition reads only the levels below its own, so this order refreshes every lower view a definition
 * reads before it, and the higher view reads it as this transaction just refreshed it. A relation named twice is
 * refreshed once: the call names a set of relations.
 *
 * One view a refresh refreshes.
 */
export interface RefreshTarget {
	/** The derived relation's declared name. */
	readonly relation: string
	/** The level of schema extension that declares it: 0 for the root schema, n for its n-th extension. */
	readonly level: number
	/** Its position among the relations of that level, in declared order. */
	readonly position: number
	/** The installed materialized view. */
	readonly view: ObjectName
}

/** A derived relation as one level of the schema declares it. */
interface Declared {
	readonly level: number
	readonly position: number
	readonly query: QueryDesc
}

/** Every derived relation of `desc` and the levels below it, by name, with its level and declared position. */
const declaredDerived = (desc: SchemaDesc): ReadonlyMap<string, Declared> => {
	const levels: Array<SchemaDesc> = []
	for (let level: SchemaDesc | undefined = desc; level !== undefined; level = level.extends) {
		levels.unshift(level)
	}
	const relations = Arr.flatMap(levels, (level, index) =>
		Arr.map(level.relations, (relation, position) => ({ relation, level: index, position }))
	)
	const out = new Map<string, Declared>()
	for (const { relation, level, position } of relations) {
		if (relation.kind === "derived" && !out.has(relation.name)) {
			out.set(relation.name, { level, position, query: relation.query })
		}
	}
	return out
}

const loc = SourceLoc("db.refresh", [])

/**
 * The name and definition of a derived relation value: a built one's own, or a JavaScript look-alike's, read once as
 * data at the builder's boundary (query/build/host.ts hostArguments) and described by derived's admission core so that
 * it is checked exactly as a built one is.
 */
const derivedOf = (
	value: unknown
): Result.Result<{ readonly name: string; readonly query: QueryDesc }, CompileError> => {
	const own = derivedDraftOf(value)
	if (own !== undefined) {
		return Result.succeed({ name: own.name, query: own.query })
	}
	if (Predicate.isObject(value) && ownedKind(value) === undefined) {
		return Result.flatMap(
			toResult(
				catchCompileError(() => {
					hostArguments("db.refresh", [value])
				})
			),
			() => {
				const { kind, name, definition } = value
				return kind === "derived"
					? Result.map(
							toResult(catchCompileError(() => admitDerived(name, definition, []))),
							(draft) => ({
								name: draft.name,
								query: draft.query
							})
						)
					: Result.fail(malformedDescription(loc, "a derived relation built by derived(...)"))
			}
		)
	}
	return Result.fail(malformedDescription(loc, "a derived relation built by derived(...)"))
}

const sameQuery = (a: QueryDesc, b: QueryDesc): boolean => {
	const x = descText(a)
	const y = descText(b)
	return x.ok && y.ok && x.value === y.value
}

/**
 * The views a refresh by `role` of `relations` refreshes, in refresh order, or the CompileError that refuses it before
 * any SQL (see the header). The role's base is the Description as it was declared, every level in its declared order
 * (the owned schema's Description is canonical, so its order is not the declared one).
 */
export const refreshTargets = (
	role: RoleDesc,
	artifacts: SchemaArtifacts,
	relations: Arr.NonEmptyReadonlyArray<unknown>
): Result.Result<Arr.NonEmptyReadonlyArray<RefreshTarget>, CompileError> => {
	const owned = artifacts.owned
	const declared = declaredDerived(role.base)
	const scope = new Set(role.refresh)
	const targetOf = (value: unknown): Result.Result<RefreshTarget, CompileError> =>
		Result.flatMap(derivedOf(value), ({ name, query }) => {
			const d = declared.get(name)
			if (d === undefined || owned.relations[name]?.kind !== "derived") {
				return Result.fail(
					malformedDescription(
						loc,
						`a derived relation of schema ${owned.name}; it declares no derived ${name}`
					)
				)
			}
			if (!sameQuery(d.query, query)) {
				return Result.fail(
					malformedDescription(
						loc,
						`the derived relation ${name} of schema ${owned.name}, whose definition differs from the value's`
					)
				)
			}
			if (!scope.has(name)) {
				return Result.fail(
					CompileError.make({
						_tag: "OutsideRole",
						at: loc,
						role: role.name,
						access: { kind: "refresh", relation: name }
					})
				)
			}
			return Result.succeed({
				relation: name,
				level: d.level,
				position: d.position,
				view: artifacts.names.relation(name)
			})
		})
	return Result.map(Result.all(Arr.map(relations, targetOf)), (targets) =>
		Arr.sort(
			Arr.dedupeWith(targets, (a, b) => a.relation === b.relation),
			Order.Struct({ level: Order.Number, position: Order.Number })
		)
	)
}
