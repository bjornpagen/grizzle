import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { ReadFailure, TransientFailure } from "#adapter/errors/execution.ts"
import { asReadFailure } from "#adapter/wire/batch.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import { type TransientTag } from "#compiler/core/errors.ts"
import { assert } from "#test/support/assert.ts"
import {
	allFeatures,
	asNamed,
	databaseError,
	deadlock,
	type Feature,
	flightFailure,
	isSqlstateSpec,
	nameFields,
	reportGen,
	resourceStates,
	serialization
} from "#test/unit/adapter/failures.fixtures.ts"

/**
 * The failure vocabulary reads every server report into exactly one class that carries its SQLSTATE, message, DETAIL,
 * HINT and named objects as given.
 *
 * Budget: its suite's count before the conversion (unit/adapter/failure-vocabulary: 2000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theFailureVocabularyReadsEveryServerReportIntoExactlyOneClassThatCarriesItsSQLSTATEMessageDETAILHINTAndNamedObjectsAsGiven =
	property.explore(reportGen, {
		needs: {},
		situations: allFeatures satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (r) =>
			Effect.sync(() => {
				c.note(`code ${r.codeKind}`)
				c.note(`message ${r.messageKind}`)
				c.note(`detail ${r.detailKind}`)
				c.note(`hint ${r.hintKind}`)
				for (const field of nameFields) {
					c.note(`name ${r.names[field].kind}`)
				}
				c.note(`severity ${r.severity}`)
				c.note(`position ${r.position}`)
				const answer = serverFailure(databaseError(r))
				const parses = r.code !== undefined && isSqlstateSpec(r.code)
				assert.equal(
					answer !== undefined,
					parses,
					"a report is read exactly when its code is a SQLSTATE"
				)
				if (answer === undefined || r.code === undefined) {
					c.note("unparsed")
					return
				}
				const error = answer.error
				/** What the server said, as it said it. */
				const sqlstate: string = error.sqlstate
				assert.equal(sqlstate, r.code)
				assert.equal(error.message, r.message)
				assert.equal(error.detail, r.detail === "" ? undefined : r.detail)
				assert.equal(error.hint, r.hint === "" ? undefined : r.hint)
				for (const field of nameFields) {
					assert.equal<string | undefined>(error[field], asNamed(r.names[field]), field)
				}
				assert.equal(
					answer._tag,
					r.severity === "FATAL" || r.severity === "PANIC" ? "terminated" : "refused"
				)
				/** A read's failure: exactly one class, carrying the same report. */
				const read = asReadFailure(flightFailure(r.position, error))
				assert.equal(
					read instanceof TransientFailure,
					!(read instanceof ReadFailure),
					"exactly one class"
				)
				const transient: TransientTag | undefined =
					r.code === serialization
						? "SerializationFailure"
						: r.code === deadlock
							? "Deadlock"
							: undefined
				if (read instanceof TransientFailure) {
					c.note("class TransientFailure")
					assert.ok(
						read.reason._tag === transient,
						`reason ${read.reason._tag}, the contract's ${transient}`
					)
					assert.equal(read.error, error)
					assert.equal(read.error.message, r.message)
					return
				}
				c.note("class ReadFailure")
				assert.equal(transient, undefined, "SERIALIZABLE's refusal and a stale name are transient")
				assert.ok(
					read instanceof ReadFailure,
					"a statement's or COMMIT's refusal is never the fence's"
				)
				assert.equal(read.reason, error)
				assert.equal(read.stage, resourceStates.has(r.code) ? "resource" : "execute")
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's SQLSTATE contract and the README's promise of a failure's fields, stated here"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/errors/execution.ts",
				original: "\t\t\t? new Deadlock()",
				replacement: "\t\t\t? new SerializationFailure()",
				why: "40P01 is read as 40001, a deadlock as a serialization failure."
			},
			{
				file: "packages/grizzle/src/adapter/errors/failures.ts",
				original:
					'const said = (text: string | undefined): string | undefined => (text === "" ? undefined : text)',
				replacement: "const said = (text: string | undefined): string | undefined => text",
				why: "An empty DETAIL or HINT is kept as one that says something."
			}
		]
	})
