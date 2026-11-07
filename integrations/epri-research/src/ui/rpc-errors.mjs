/** Preserve original research recovery codes across the authenticated native RPC and iframe MessagePort. */
export function researchError(message, code) {
  const error = new Error(typeof message === 'string' ? message : '科研操作未确认，请检查当前对话。');
  if (typeof code === 'string') error.code = code === 'research/not-found' ? 'NOT_FOUND' : code === 'research/conflict' ? 'CONFLICT' : code;
  return error;
}

/** Keep the existing string error payload; only the optional recovery code is added. */
export function researchFailure(error) {
  return {ok: false, error: error.message, ...(typeof error.code === 'string' ? {code: error.code} : {})};
}
