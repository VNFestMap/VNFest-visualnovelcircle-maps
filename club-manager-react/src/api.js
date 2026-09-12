const API_ROOT = '../api/';

export class ApiError extends Error {
  constructor(message, payload = null, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.payload = payload;
    this.status = status;
  }
}

function resolveMessage(payload, fallback) {
  return payload?.message || payload?.error || fallback;
}

export async function request(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`服务返回了无法解析的数据（HTTP ${response.status}）`, null, response.status);
  }
  if (!response.ok || payload?.success === false) {
    throw new ApiError(resolveMessage(payload, `请求失败（HTTP ${response.status}）`), payload, response.status);
  }
  return payload;
}

export const api = {
  get(path) { return request(path); },
  post(path, body) {
    return request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  },
  upload(path, formData) {
    return request(path, { method: 'POST', body: formData });
  },
};

export function normalizeError(error, fallback = '操作失败') {
  if (error instanceof ApiError) return error.message;
  return error?.message || fallback;
}
