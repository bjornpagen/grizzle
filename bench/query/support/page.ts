import { type Array as Arr, Effect, Function, Result } from "effect"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { type PageCall, windowIntake, windowStatement } from "#adapter/page/execute.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import type { HostParams } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { compiledPageTemplateFor } from "#adapter/served/forms.ts"
import { type FlightFailure, readFrame, runFramed, takenRows } from "#adapter/wire/batch.ts"
import type { VariantStatement } from "#bench/harness/variant.ts"
import {
	type Compiled,
	type DeliveryFailed,
	deliveryFailed,
	GateSetupError,
	type Runtime,
	sentStatements
} from "#bench/query/support/kit.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { PageArtifact } from "#compiler/lower/shapes/page/compile.ts"
import type { Select } from "#compiler/sql/ast.ts"
import { programAsts } from "#test/support/compile.ts"
import { conservativePageRuntime } from "#test/support/conservative.ts"

/**
 * A window as the page runtime runs it (R05).
 *
 * The page runtime template of an ordered query (packages/grizzle/src/adapter/page/template.ts pageRuntimeOf, the
 * runtime's own constructor) holds, per artifact and template variant, the one statement of a window: its rows part
 * with its page placeholders, and its attachments. A window is delivered as the runtime delivers it: its relation
 * inputs normalized (reader/relations.ts), its statement built by the runtime's windowStatement from the call
 * (packages/grizzle/src/adapter/page/execute.ts), which binds the limit, the size and the boundary texts exactly as the
 * runtime receives them, its rows read by the runtime's windowIntake, and sent on the recording session in one flight.
 * The statement that flight sent, with its parameters, is what a gate measures.
 *
 * The page runtime of a template compiled with read "page", with the installation's codes its artifacts were compiled
 * under, which the request's parameter codecs read, as a Db's role's artifacts give them (adapter/page/page.ts).
 */
export type BenchPages = PageRuntime & {
	readonly codes: Codebook
	/** The compiled page artifact the runtime was served from, whose statements a variant rewrites. */
	readonly compiled: PageArtifact
}

export const pageRuntime = (compiled: Compiled): BenchPages => {
	const built = compiledPageTemplateFor({
		template: compiled.compiled.template,
		desc: compiled.desc,
		artifacts: compiled.artifacts
	})
	if (Result.isFailure(built)) {
		throw new GateSetupError({ what: `the page template: ${built.failure.message}` })
	}
	return {
		...built.success.runtime,
		codes: compiled.artifacts.names.codes,
		compiled: built.success.template.artifact
	}
}

/** The page runtime of `pages`'s query through the page oracle's conservative artifact (test/support/conservative.ts). */
export const conservativePages = (compiled: Compiled, pages: BenchPages): BenchPages => {
	const built = conservativePageRuntime(
		pages,
		compiled.compiled.template,
		compiled.desc,
		compiled.artifacts
	)
	if (Result.isFailure(built)) {
		throw new GateSetupError({ what: `the conservative page template: ${built.failure.message}` })
	}
	return { ...built.success.runtime, codes: pages.codes, compiled: built.success.artifact }
}

export interface DeliveredPage {
	/** What the window's flight sent: its one statement, its rows and attachments. */
	readonly statements: Arr.NonEmptyReadonlyArray<VariantStatement>
	/**
	 * The window's statement, as it was sent, and its typed AST as compiled, as a reader reads it
	 * (test/support/compile.ts programAsts).
	 */
	readonly rows: {
		readonly sent: VariantStatement
		readonly ast: Select
	}
	readonly flights: number
}

/** Delivers one window of `pages` as the runtime does, its rows read through the runtime's window intake. */
export const deliverPage = Effect.fn("deliverPage")(
	function* (
		runtime: Runtime,
		pages: BenchPages,
		values: HostParams,
		call: PageCall
	): Effect.fn.Return<DeliveredPage, DeliveryFailed | ReadError | FlightFailure> {
		const inputs = executionInputs(paramCodecs(pages.params, pages.codes), values)
		if (Result.isFailure(inputs)) {
			return yield* deliveryFailed(new ReadFailure({ reason: inputs.failure }))
		}
		const program = pages.artifact.requests[call.variant]
		const intake = windowIntake(program, call.size, Function.constVoid)
		const statement = yield* Effect.mapError(
			windowStatement(pages, inputs.success, call, takenRows(intake.take)),
			(reason) => new ReadFailure({ reason })
		)
		runtime.recorded.length = 0
		runtime.flights = 0
		yield* runFramed(runtime.session, readFrame(runtime.prologue, false), [statement])
		yield* Effect.mapError(Effect.fromResult(intake.end()), (reason) => new ReadFailure({ reason }))
		const statements = sentStatements(runtime)
		if (program.delivery.kind !== "concat") {
			throw new GateSetupError({
				what: `the ${call.variant} window delivers heading groups, not one rows part`
			})
		}
		return {
			statements,
			rows: {
				sent: statements[0],
				ast: programAsts(pages.compiled.requests[call.variant].program)[0]
			},
			flights: runtime.flights
		}
	},
	Effect.mapError((e) => (e._tag === "DeliveryFailed" ? e : deliveryFailed(e)))
)
