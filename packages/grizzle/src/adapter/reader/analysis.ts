import * as Arr from "effect/Array"
import type { ServedAttach, ServedSpine } from "#compiler/plan/serve.ts"

/**
 * Where a read's statements are on its delivered spine, which its Description states (engine served/read.ts
 * servedSpine): each delivered attachment by name, its child's head keys and the delivered attachments under it.
 *
 * Each attachment's delivered type is the one the template's analysis judged under the context the read runs in, which
 * every attachment of a served program carries (ServedAttach judged), as TypeScript types it (Attached<Child, Ev>):
 * ReadonlyArray without evidence, Option when the child's bindings on the parent's variables cover a key of the child
 * relation, the child is take(1), or it is an aggregate whose group the parent fixes, and the bare child when a
 * containment proves exactly one. Its correlation is the child columns equated with parent columns.
 *
 * An attachment delivers its child query's head: the checker adds a correlation column to the child for each parent
 * variable the child reads, delivered under a head key when one delivers that variable and under a fresh name clear of
 * every head key otherwise (check/checker.ts attach). A correlation column no head key delivers equals the parent's
 * value and is not part of the delivered child.
 *
 * Whether an attachment's delivered child carries the child column `column`: every child column but the correlation
 * columns no head key delivers. `scope` is where the attachment is on the delivered spine, none off it.
 */
export const carried = (
	attach: ServedAttach,
	scope: ServedSpine | undefined,
	column: string
): boolean =>
	!Arr.some(attach.correlation, (c) => c.child === column) ||
	scope?.under.get(attach.name)?.heads.has(column) === true
