import assert from "node:assert"
declare const failure: { message: string; what: string; tag: string }
declare const a: unknown
declare const containsText: (text: string, part: string) => void
declare const lacksText: (text: string, part: string) => void
assert.equal(failure.what, "a table") // violation
assert.match(failure.what, /table/) // violation
containsText(failure.message, "missing") // violation
lacksText(failure.what, "table") // violation
containsText(JSON.stringify(a), "x") // violation
assert.equal(failure.tag, "Missing")
containsText(failure.tag, "Missing")
