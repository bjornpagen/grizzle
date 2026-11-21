import { canonicalEquals } from "#compiler/core/canonical.ts"
import type { ClockBinding, ClockSource } from "#compiler/ir/clock.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"

/**
 * What a write front end is a function of beside its ChangeSet and its claims (write/frontend/compile.ts
 * FrontendOptions), as a workload's plan and a login's served compile each name it: the law model of the artifacts it
 * is compiled over, a basis's (physical/install/plan.ts PlanBasis `model`), which every artifacts of one basis hold and
 * fix the checked schema, the derived analysis and the codes of, and which artifacts of another basis never hold; the
 * login and the role whose ChangeSet it is, by their owned names, which fix the role's checked world over that basis;
 * the program, by its name in the login's workloads, which fixes the ChangeSet; the clock binding it serves; and where
 * its readings of the clock count from. The front end reads no installed name (no `world` among its options), so two
 * artifacts of one basis that name the installation apart, a plan's over unserved parameter types and a served
 * compile's over planned ones, compile one front end of one key.
 */
export interface FrontendKey {
	readonly laws: LawModel
	readonly login: string
	readonly role: string
	readonly program: string
	readonly clock: ClockBinding
	readonly source: ClockSource
}

/**
 * The front ends a workload's plan compiled of its ChangeSets over the roles their workloads run on
 * (program/workload/compile.ts planWorkload), each under the claims of every context (write/frontend/entry.ts
 * EntryClaims `every`), by its key (FrontendKey): what a login's served compile reads for the variant of each such
 * ChangeSet in which every fill context holds a fact (change.ts preparedVariants), whose front end is that one, where it
 * compiled the ChangeSet a second time. Owned by the generate that plans and serves, and dropped with it.
 */
export class PlannedFrontends {
	readonly #planned: ReadonlyMap<string, PlannedFrontend>

	/** Each of `planned`'s front ends, compiled under every context's claims, as the front end of its key. */
	constructor(planned: ReadonlyArray<PlannedFrontend>) {
		this.#planned = new Map(planned.map((p) => [placeOf(p.key), p] as const))
	}

	/**
	 * The front end of `key` under every context's claims: the plan's, where it planned the program of that login and
	 * role over the same law model with the same clock binding and source; none otherwise, so a login over another
	 * basis, a moved clock or a program its plan read over a level compiles its own.
	 */
	everyHolding(key: FrontendKey): WriteFrontend | undefined {
		const planned = this.#planned.get(placeOf(key))
		return planned !== undefined &&
			planned.key.laws === key.laws &&
			planned.key.source.kind === key.source.kind &&
			canonicalEquals(planned.key.clock, key.clock)
			? planned.frontend
			: undefined
	}
}

/** A front end a plan compiled under every context's claims, with its key. */
export interface PlannedFrontend {
	readonly key: FrontendKey
	readonly frontend: WriteFrontend
}

/** Where a key's front end is recorded: its login, role and program, each a declared name, which holds no NUL. */
const placeOf = (key: FrontendKey): string => `${key.login}\u0000${key.role}\u0000${key.program}`

/** No front end planned: the served compile of a login whose workloads no plan compiled beside it. */
export const noPlannedFrontends: PlannedFrontends = new PlannedFrontends([])
