export { CredentialError } from "#adapter/errors/credential.ts"
export { OpenError, type OpenReason, type OpenStage } from "#adapter/errors/execution.ts"

export {
	type AttestationFault,
	AttestationRefused,
	type ClaimFault,
	ClaimRefused,
	ConnectionEnvironmentRefused,
	DbConfigRefused,
	ExpiryRefused,
	LiveSourceMissing,
	RecordsUnserved,
	RoleOutsideLayers,
	ServedLoginRefused,
	type SettingFault,
	type SettingRule,
	TokenMalformed,
	TokenRefused,
	VerifierUnavailable
} from "#adapter/errors/failures.ts"
