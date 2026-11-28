import { Array as Arr, String as Str } from "effect"
import { outsideTheRepository } from "#test/support/readme.ts"
import { batchOwned, caseOwned, type Owner, type Program } from "#test/support/types/batch/batch.ts"
import { readmeFixtures, type StatedRefusal } from "#test/types/examples/documents.ts"

/**
 * The README's fixtures as a batch's program: both modules whole, readme.app.ts importing readme.ts by its file
 * (outsideTheRepository), so every refusal the README states is checked in the program it stands in. Each directive of the batch's
 * refusals, and the line it claims, are that refusal's own lines; every other line, the other refusals' among them, is
 * the batch's, so every batch judges every claim of the README.
 */
export const readmeProgram = (refusals: Arr.NonEmptyReadonlyArray<StatedRefusal>): Program => {
	const owners = new Map<string, Owner>()
	const at = (file: string, line: number) => `${file}:${line}`
	for (const [index, refusal] of refusals.entries()) {
		owners.set(at(refusal.file, refusal.line), caseOwned(index))
		owners.set(at(refusal.file, refusal.line + 1), caseOwned(index))
	}
	return Arr.map(readmeFixtures, ({ file, text }) => ({
		file: Arr.lastNonEmpty(Str.split(file, "/")),
		parts: Arr.map(Str.split(text, "\n"), (line, index) => ({
			owner: owners.get(at(file, index + 1)) ?? batchOwned,
			lines: [outsideTheRepository(line)]
		}))
	}))
}
