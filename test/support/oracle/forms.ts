import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ConservativeParamSlot } from "#compiler/lower/conservative/types.ts"
import type { FormedStatement, SentStatement } from "#compiler/lower/shapes/index.ts"

/**
 * The statements an optimized program may send, as the oracles run them: its statement, and its large form when its
 * shapes made a per-execution choice, which an execution whose choice exceeds its threshold sends instead. Both divide
 * into the program's parts alike.
 */
export const sentForms = <C, Slot extends ConservativeParamSlot>(
	statement: FormedStatement<C, Slot>
): NonEmptyReadonlyArray<SentStatement<Slot>> =>
	statement.forms.kind === "chosen" ? [statement, statement.forms.large] : [statement]
