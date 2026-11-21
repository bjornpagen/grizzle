import { dictionary } from "@bjornpagen/testing/dictionary"

/** How a holder's scope ends. */
export type Ending = "succeeds" | "fails" | "is interrupted"

/** Every way a holder's scope ends. */
export const endings = dictionary<Ending>(["succeeds", "fails", "is interrupted"])
