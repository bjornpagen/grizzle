import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { Array as Arr } from "effect"
import type {
	CteUse,
	ProbeFact,
	ReadAt,
	RowSource,
	SiteCore
} from "#compiler/analysis/isolation/facts.ts"

/**
 * A row source of a statement that reads each query CTE again at each of its sites: a read, a core or a UNION's arms,
 * never a use (analysis/isolation/facts.ts RowSource).
 */
export type FlatRowSource =
	| { readonly kind: "read"; readonly read: number }
	| { readonly kind: "core"; readonly core: number }
	| {
			readonly kind: "union"
			readonly arms: NonEmptyReadonlyArray<ReadonlyArray<FlatRowSource>>
	  }

/** A read that stands beneath probes of its body. */
interface Probed {
	readonly probes: ReadonlyArray<number>
}

/** A write fed by reads of a statement, each by its body and place. */
interface Fed {
	readonly from: ReadonlyArray<ReadAt>
}

/** One body of a statement whose query CTEs are instances (analysis/isolation/facts.ts BodyFacts), its reads `R`. */
export interface SharedBody<R, Core extends SiteCore> {
	readonly reads: ReadonlyArray<R>
	readonly probes: ReadonlyArray<ProbeFact<Core>>
	readonly cores: ReadonlyArray<ReadonlyArray<RowSource>>
	readonly uses: ReadonlyArray<CteUse>
}

/**
 * A statement whose query CTEs are instances (analysis/isolation/facts.ts StatementFacts), its reads `R` and its writes
 * `W`, a sketch's or the facts' own.
 */
export interface SharedStatement<R, W> extends SharedBody<R, number | undefined> {
	readonly writes: ReadonlyArray<W>
	readonly ctes: ReadonlyArray<
		SharedBody<R, number | "site"> & { readonly rows: ReadonlyArray<RowSource> }
	>
}

/**
 * A statement that reads each query CTE again at each of its sites: every read, probe and core by its place among the
 * statement's, each write fed by the reads it names by place, the read of the statement each read is again
 * (`origins`, by place), and the probe of the statement each probe is again, by its body and place (`probeOrigins`).
 */
export interface FlatStatement<R, W> {
	readonly writes: ReadonlyArray<Omit<W, "from"> & { readonly from: ReadonlyArray<number> }>
	readonly reads: ReadonlyArray<R>
	readonly origins: ReadonlyArray<ReadAt>
	readonly probeOrigins: ReadonlyArray<{ readonly cte: number | undefined; readonly probe: number }>
	readonly probes: ReadonlyArray<ProbeFact>
	readonly cores: ReadonlyArray<ReadonlyArray<FlatRowSource>>
}

/**
 * `s` with each query CTE instance read again at each use of it: the instance's reads, probes and cores once per use
 * that reaches it, each read beneath the use's probes, then its own, each probe chained beneath them too and a `site`
 * probe standing in the use's core, and the instance's rows spliced into the using core's row sources where the use
 * stands. Reads come in the order such a walk finds them, an instance's at its use, between the using body's reads
 * before it and after it; a write is fed by every read of each read it names. An instance no use reaches reads nothing.
 * This is the statement as a walk that read each query CTE again at each site found it, which the certifier's verdicts
 * on `s` must agree with.
 */
export const expanded = <R extends Probed, W extends Fed>(
	s: SharedStatement<R, W>
): FlatStatement<R, W> => {
	const reads: Array<R> = []
	const origins: Array<ReadAt> = []
	const probes: Array<ProbeFact> = []
	const probeOrigins: Array<{ readonly cte: number | undefined; readonly probe: number }> = []
	const cores: Array<ReadonlyArray<FlatRowSource>> = []
	const places = new TupleMap<readonly [number | undefined, number], Array<number>>()
	const emit = (
		cte: number | undefined,
		body: SharedBody<R, SiteCore>,
		rows: ReadonlyArray<RowSource>,
		prefix: ReadonlyArray<number>,
		site: number | undefined
	): ReadonlyArray<FlatRowSource> => {
		const probeBase = probes.length
		const coreBase = cores.length
		const chained = (ids: ReadonlyArray<number>): ReadonlyArray<number> => [
			...prefix,
			...Arr.map(ids, (id) => probeBase + id)
		]
		for (const [probe, p] of body.probes.entries()) {
			probeOrigins.push({ cte, probe })
			probes.push({
				gates: p.gates,
				core: p.core === "site" ? site : p.core === undefined ? undefined : coreBase + p.core,
				chain: chained(p.chain)
			})
		}
		for (const _ of body.cores) {
			cores.push([])
		}
		const readAt: Array<number> = []
		const useRows: Array<ReadonlyArray<FlatRowSource>> = []
		let next = 0
		const upTo = (end: number): void => {
			for (; next < end; next++) {
				const read = body.reads[next]
				if (read === undefined) {
					continue
				}
				readAt[next] = reads.length
				const held = places.get([cte, next]) ?? []
				held.push(reads.length)
				places.set([cte, next], held)
				reads.push({ ...read, probes: chained(read.probes) })
				origins.push({ cte, read: next })
			}
		}
		for (const [place, use] of body.uses.entries()) {
			upTo(use.at)
			const instance = s.ctes[use.cte]
			useRows[place] =
				instance === undefined
					? []
					: emit(
							use.cte,
							instance,
							instance.rows,
							chained(use.probes),
							use.core === undefined ? undefined : coreBase + use.core
						)
		}
		upTo(body.reads.length)
		const source = (r: RowSource): ReadonlyArray<FlatRowSource> => {
			switch (r.kind) {
				case "read": {
					const read = readAt[r.read]
					return read === undefined ? [] : [{ kind: "read", read }]
				}
				case "core":
					return [{ kind: "core", core: coreBase + r.core }]
				case "union":
					return [{ kind: "union", arms: Arr.map(r.arms, (arm) => Arr.flatMap(arm, source)) }]
				case "use":
					return useRows[r.use] ?? []
			}
		}
		for (const [j, sources] of body.cores.entries()) {
			cores[coreBase + j] = Arr.flatMap(sources, source)
		}
		return Arr.flatMap(rows, source)
	}
	emit(undefined, s, [], [], undefined)
	return {
		writes: Arr.map(s.writes, (w) => ({
			...w,
			from: Arr.flatMap(w.from, (at) => places.get([at.cte, at.read]) ?? [])
		})),
		reads,
		origins,
		probes,
		probeOrigins,
		cores
	}
}
