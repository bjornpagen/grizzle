import assert from "node:assert"
declare const failure: { message: string; what: string; tag: string }
declare const other: { what: string }
declare const emitted: string
declare const secret: string
declare const containsText: (text: string, part: string) => void
declare const lacksText: (text: string, part: string) => void
assert.equal(failure.what, other.what)
assert.equal(failure.tag, "Missing")
containsText(emitted, "SELECT")
lacksText(JSON.stringify(failure), secret)
