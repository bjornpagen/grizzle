export const literal = /ab+c/ // violation
export const built = new RegExp("ab+c") // violation
export const called = RegExp("ab+c") // violation
export const text = "/ab+c/"
