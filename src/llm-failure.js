export const LlmFailure = {
  CONTEXT_WINDOW_EXCEEDED:'CONTEXT_WINDOW_EXCEEDED',
  EMPTY_RESPONSE:'EMPTY_RESPONSE', TIMEOUT:'TIMEOUT',
  RATE_LIMITED:'RATE_LIMITED', AUTH:'AUTH',
  SERVER:'SERVER', NETWORK:'NETWORK', UNKNOWN:'UNKNOWN'
};

export function normalizeFailure(err) {
  if (!err) return {code:LlmFailure.UNKNOWN,httpStatus:null,retryAfterMs:null,retryable:false};
  if (err.name==='AbortError') return {code:LlmFailure.TIMEOUT,httpStatus:null,retryAfterMs:null,retryable:true};
  const s=err.status||err.statusCode;
  if (s===429) return {code:LlmFailure.RATE_LIMITED,httpStatus:429,retryAfterMs:parseInt(err.headers?.['retry-after'])*1000||2000,retryable:true};
  if (s===401||s===403) return {code:LlmFailure.AUTH,httpStatus:s,retryAfterMs:null,retryable:false};
  if (s>=500) return {code:LlmFailure.SERVER,httpStatus:s,retryAfterMs:null,retryable:true};
  const c=err.code||'';
  if(['ECONNRESET','ETIMEDOUT','ENOTFOUND','ECONNREFUSED'].includes(c)) return {code:LlmFailure.NETWORK,httpStatus:null,retryAfterMs:null,retryable:true};
  const m=err.message||'';
  if(/context.*window|max.context|too many tokens|maximum.context|context_length_exceeded/i.test(m)) return {code:LlmFailure.CONTEXT_WINDOW_EXCEEDED,httpStatus:s,retryAfterMs:null,retryable:false};
  if(/empty|no content|no choices/i.test(m)) return {code:LlmFailure.EMPTY_RESPONSE,httpStatus:s,retryAfterMs:null,retryable:true};
  return {code:LlmFailure.UNKNOWN,httpStatus:s,retryAfterMs:null,retryable:!!s};
}
