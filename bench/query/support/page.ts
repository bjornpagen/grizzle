import { type Array as Arr, Effect, Result } from "effect"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { type PageCall, pageFlight } from "#adapter/page/execute.ts"
import { type PageArtifactName, type PageRuntime, pageTemplateFor } from "#adapter/page/template.ts"
import { answerOf, type HostParams } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { type FlightFailure, readFrame, runFramed } from "#adapter/wire/batch.ts"
import type { VariantStatement } from "#bench/harness/variant.ts"
import {
	type Compiled,
	type DeliveryFailed,
	deliveryFailed,
	GateSetupError,
	type Runtime,
	sentStatements
} from "#bench/query/support/kit.ts"
import type { PageStatementSlot } from "#compiler/lower/conservative/types.ts"
import type { FusedStatement } from "#compiler/lower/shapes/index.ts"
import { transportLimits } from "#compiler/lower/shapes/relparam/index.ts"

/**
 * A page request as the page runtime runs it (R05).
 *
 * The page runtime template of an ordered query (packages/grizzle/src/adapter/page/template.ts pageTemplateFor, the runtime's own
 * constructor) holds, per artifact and request variant, the statements of a request: its rows statement with its page
 * placeholders, its attachments and, for an anchored request, its probe. A request is delivered as the runtime
 * delivers it: its relation inputs normalized (reader/relations.ts), its flight built by the runtime's pageFlight from
 * the call (packages/grizzle/src/adapter/page/execute.ts), which binds the limit, the size and the boundary texts exactly as the runtime
 * receives them, and sent on the recording session in one flight. The statements that flight sent, with their
 * parameters, are what a gate measures.
 *
 *  The page runtime of a template compiled with read "page".
 */
export const pageRuntime = (compiled: Compiled): PageRuntime => {
	const built = pageTemplateFor({
		template: compiled.compiled.template,
		desc: compiled.desc,
		artifacts: compiled.artifacts
	})
	if (Result.isFailure(built)) {
		throw new GateSetupError({ what: `the page template: ${built.failure.message}` })
	}
	return built.success
}

export interface DeliveredPage {
	/** What the request's flight sent, in order: its rows statement and attachments, then its probe. */
	readonly statements: Arr.NonEmptyReadonlyArray<VariantStatement>
	/** The request's rows statement, as it was sent and as it was compiled. */
	readonly rows: {
		readonly sent: VariantStatement
		readonly statement: FusedStatement<PageStatementSlot>
	}
	readonly flights: number
}

/** Delivers one page request of `artifact` as the runtime does, its rows read through the flight's own reading. */
export const deliverPage = Effect.fn("deliverPage")(
	function* (
		runtime: Runtime,
		pages: PageRuntime,
		artifact: PageArtifactName,
		values: HostParams,
		call: PageCall
	): Effect.fn.Return<DeliveredPage, DeliveryFailed | ReadError | FlightFailure> {
		const inputs = executionInputs(paramCodecs(pages.params), values, transportLimits)
		if (Result.isFailure(inputs)) {
			return yield* deliveryFailed(new ReadFailure({ reason: inputs.failure }))
		}
		const flight = yield* Effect.mapError(
			pageFlight(pages, artifact, inputs.success, call),
			(reason) => new ReadFailure({ reason })
		)
		runtime.recorded.length = 0
		runtime.flights = 0
		yield* Effect.flatMap(
			runFramed(runtime.session, readFrame(runtime.prologue), flight.statements),
			(outcomes) => Effect.mapError(flight.read(outcomes), (reason) => new ReadFailure({ reason }))
		)
		const statements = sentStatements(runtime)
		/** The flight sends the request's statements in program order, its probe after them. */
		const program = pages.artifacts[artifact].requests[call.variant]
		const delivery = program.delivery
		if (delivery.kind !== "concat") {
			throw new GateSetupError({
				what: `the ${call.variant} request delivers heading groups, not one rows statement`
			})
		}
		const record = delivery.groups[0].record
		const sent = statements[answerOf(record.arrival)]
		if (sent === undefined) {
			throw new GateSetupError({
				what: `the ${call.variant} request sent no rows statement ${answerOf(record.arrival)}`
			})
		}
		return {
			statements,
			rows: { sent, statement: record.run.statement },
			flights: runtime.flights
		}
	},
	Effect.mapError((e) => (e._tag === "DeliveryFailed" ? e : deliveryFailed(e)))
)
