export const fail = new Error("x") // violation
export const type = new TypeError("x") // violation
export const called = Error("x") // violation
export const suppressed = new SuppressedError(1, 2, "x") // violation
class Failure {
	constructor(readonly reason: string) {}
}
export const typed = new Failure("x")
