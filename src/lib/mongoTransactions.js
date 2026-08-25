const TRANSACTION_UNSUPPORTED_CODE = 20;
const TRANSACTION_UNSUPPORTED_CODE_NAME = "IllegalOperation";
const TRANSACTION_UNSUPPORTED_MESSAGE =
  "Transaction numbers are only allowed on a replica set member or mongos";

function isCanonicalUnsupportedError(error) {
  return (
    error?.code === TRANSACTION_UNSUPPORTED_CODE &&
    error?.codeName === TRANSACTION_UNSUPPORTED_CODE_NAME &&
    error?.message === TRANSACTION_UNSUPPORTED_MESSAGE
  );
}

export function isTransactionUnsupportedError(error) {
  return (
    isCanonicalUnsupportedError(error) ||
    isCanonicalUnsupportedError(error?.cause)
  );
}
