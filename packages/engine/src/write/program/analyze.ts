import {
	extendNonEmpty,
	isNonEmpty,
	type NonEmptyReadonlyArray,
	sortNonEmpty
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { oneForm } from "#compiler/runtime/lower/forms.ts"
import { stratumOf } from "#compiler/runtime/write/steps.ts"
import { relationAccess } from "#compiler/sql/access.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { type CarrierName, emptyNameMap } from "#compiler/sql/naming.ts"
import { buildAnalyzeCarriers, type WriteCarrier } from "#compiler/write/carriers/carriers.ts"
import {
	type PlacedStatement,
	placedStep,
	settledArtifact,
	type WriteArtifact,
	writeStatementSpec
} from "#compiler/write/program/artifact.ts"

/** One statement's access to the program's carriers. */
interface CarrierAccess {
	readonly reads: ReadonlySet<CarrierName>
	readonly writes: ReadonlySet<CarrierName>
	readonly stored: boolean
}

const carrierAccess = (
	statement: SqlStatement,
	carriers: ReadonlySet<CarrierName>
): CarrierAccess => {
	const access = relationAccess(statement)
	return {
		reads: new Set([...carriers].filter((c) => access.reads.has(c))),
		writes: new Set([...carriers].filter((c) => access.writes.has(c))),
		stored: access.stored
	}
}

const touches = (access: CarrierAccess, carrier: CarrierName): boolean =>
	access.reads.has(carrier) || access.writes.has(carrier)

/** The carriers a statement reads with a stored relation, which must be analyzed before it. */
const joined = (access: CarrierAccess): ReadonlySet<CarrierName> =>
	access.stored ? access.reads : new Set()

/** Whether `carrier` is next accessed after `here`, among `after`, by a statement that joins it, with no write to it
 * from `here` on: a statement joining a carrier reads it. */
const nextJoinedWithoutWrite = (
	carrier: CarrierName,
	here: CarrierAccess,
	after: ReadonlyArray<CarrierAccess>
): boolean => {
	if (here.writes.has(carrier)) {
		return false
	}
	const next = after.find((a) => touches(a, carrier))
	return next !== undefined && joined(next).has(carrier)
}

/** Per position of `access`, the carriers to analyze just before the statement there. */
const pointsOf = (
	access: ReadonlyArray<CarrierAccess>
): ReadonlyMap<number, NonEmptyReadonlyArray<CarrierName>> => {
	const points = new Map<number, NonEmptyReadonlyArray<CarrierName>>()
	/** Created or written since the last ANALYZE. */
	const stale = new Set<CarrierName>()
	for (const [i, a] of access.entries()) {
		const needed = [...joined(a)].filter((c) => stale.has(c))
		if (isNonEmpty(needed)) {
			const after = access.slice(i + 1)
			const others = [...stale].filter(
				(c) => !needed.includes(c) && nextJoinedWithoutWrite(c, a, after)
			)
			const batch = sortNonEmpty(extendNonEmpty(needed, others), compareStrings)
			for (const c of batch) {
				stale.delete(c)
			}
			points.set(i, batch)
		}
		for (const c of a.writes) {
			stale.add(c)
		}
	}
	return points
}

/** Moves an artifact position past the inserted statements. */
type Move = (position: number) => number

/** The artifact of the statements `placed` and its carriers, analyzed before the statements that join them.
 * A transaction-scoped carrier is a temporary relation created empty in the transaction that fills it, so PostgreSQL
 * has never analyzed it when a later statement reads it, and the planner then assumes at least ten pages of rows: a
 * one-row carrier of five narrow columns is estimated at about 1200 rows. Against that guess a statement that
 * joins the carrier with a stored relation prefers a hash join over a sequential scan of the stored relation to a
 * nested loop over its key, and under SERIALIZABLE a sequential scan takes a relation-level SIRead lock, which makes
 * every concurrent writer of that relation a conflict. ANALYZE counts the rows the transaction itself inserted, so
 * after it the carrier's estimate is exact.
 *
 * So the program analyzes each carrier after it is filled and before the first statement that reads it together with
 * a stored relation: before such a statement, every carrier it reads that was created or written since its last
 * ANALYZE is analyzed. A statement that reads carriers alone, such as one carrier's fill from another, plans the same
 * whatever their estimates and triggers nothing. To spare round trips, that ANALYZE also takes every other such
 * carrier whose next access is a statement of that kind, so long as nothing writes it before then (the statement
 * itself included, whose writes follow the ANALYZE). The policy has no size threshold.
 *
 * The pass runs over a finished artifact, the optimized one and the conservative one alike, and inserts each ANALYZE
 * as a statement of its own, with every artifact position moved past it: the dependencies, and the strata, read-backs,
 * deltas and name map the settled artifact derives from the statements. An ANALYZE depends on every earlier statement that accesses one of its carriers, and every later
 * statement that accesses one depends on it. Each ANALYZE names only carriers an earlier statement of the program
 * created. */
export const withCarrierAnalysis = (
	placed: ReadonlyArray<PlacedStatement>,
	carriers: ReadonlyArray<WriteCarrier>
): WriteArtifact => {
	const names = new Set(carriers.map((c) => c.name))
	const accessed = placed.map((p) => ({ placed: p, access: carrierAccess(p.ast, names) }))
	const points = pointsOf(accessed.map((a) => a.access))
	if (points.size === 0) {
		return settledArtifact(placed, carriers)
	}
	/** A position moves past every ANALYZE inserted at or before it. */
	const analyzed = [...points.keys()]
	const move: Move = (p) => p + analyzed.filter((at) => at <= p).length
	const out: Array<PlacedStatement> = []
	/** The inserted ANALYZE statements so far: their new positions and carriers. */
	const analyses: Array<{
		readonly position: number
		readonly carriers: ReadonlyArray<CarrierName>
	}> = []
	for (const [i, { placed: p, access }] of accessed.entries()) {
		const batch = points.get(i)
		if (batch !== undefined) {
			const position = out.length
			const deps = new Set([
				...accessed
					.slice(0, i)
					.flatMap((earlier, j) =>
						batch.some((c) => touches(earlier.access, c)) ? [move(j)] : []
					),
				...analyses
					.filter((earlier) => earlier.carriers.some((c) => batch.includes(c)))
					.map((earlier) => earlier.position)
			])
			const statement = buildAnalyzeCarriers(batch)
			out.push({
				kind: "own",
				step: Object.freeze({
					kind: "analyze",
					carriers: batch,
					stratum: stratumOf(placedStep(p))
				}),
				spec: writeStatementSpec(
					statement,
					[...deps].toSorted((x, y) => x - y)
				),
				ast: statement.ast,
				forms: oneForm,
				names: emptyNameMap,
				riders: []
			})
			analyses.push({ position, carriers: batch })
		}
		const deps = new Set(p.spec.dependsOn.map(move))
		for (const earlier of analyses) {
			if (earlier.carriers.some((c) => touches(access, c))) {
				deps.add(earlier.position)
			}
		}
		const dependsOn = Object.freeze([...deps].toSorted((x, y) => x - y))
		out.push(
			p.kind === "own"
				? { ...p, spec: Object.freeze({ ...p.spec, dependsOn }) }
				: { ...p, spec: Object.freeze({ ...p.spec, dependsOn }) }
		)
	}
	return settledArtifact(out, carriers)
}
