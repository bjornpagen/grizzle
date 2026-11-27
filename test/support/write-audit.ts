/**
 * The structural audit of a write's statements as a gate reads them (bench/write/support/writes.ts observedChange):
 * each statement's AST audit and the text audit of every text the runtime may send for it (oracle/verify/sql.ts), as
 * the write oracle holds every optimized write statement to them. A violation is a compiler defect.
 */
import { Array as Arr, Effect } from "effect"
import { attemptLabel, type OpenedDb, observedChange } from "#bench/write/support/writes.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	guardedTermsOf
} from "#test/support/oracle/verify/sql.ts"

/** Every violation the audit finds in the statements of the write of `changes` on `opened`, each as one line. */
export const writeAuditViolations = (
	opened: OpenedDb,
	changes: unknown
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.map(observedChange(opened, changes, attemptLabel, { kind: "none" }), (observed) =>
		Arr.flatMap(observed.statements, (s, i) =>
			Arr.map(
				[
					...auditStatementViolations(s.ast),
					...Arr.flatMap(s.texts, (text) => auditTextViolations(text, guardedTermsOf(s.ast)))
				],
				(v) => `statement ${i}: ${v.rule} at ${v.where}: ${v.detail}`
			)
		)
	)
