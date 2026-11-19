const TOKEN_KEY = 'ms_token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token && !path.startsWith('/auth/login')) { setToken(null); window.location.href = '/login'; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || data.message || `Request failed (${res.status})`, data.details);
  return data as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});

/** Download a binary (PDF/Excel) with the auth header, then hand it to the browser. */
export async function download(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function openFile(id: string) {
  const token = getToken();
  const res = await fetch(`/api/files/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'File not available');
  window.open(URL.createObjectURL(await res.blob()), '_blank');
}
export function fileToUpload(file: File): Promise<{ name: string; mimeType: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, mimeType: file.type, dataBase64: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
