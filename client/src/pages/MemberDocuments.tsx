import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { ErrorBox, Loading, useAction, useApi } from '../ui';
import { useAuth } from '../auth';

type Kind = 'photo' | 'id_front' | 'id_back';
const SLOTS: { kind: Kind; label: string; hint: string; camera: 'user' | 'environment' }[] = [
  { kind: 'photo', label: 'Passport-style photo', hint: 'A clear, recent photo of your face', camera: 'user' },
  { kind: 'id_front', label: 'ID card, front', hint: 'The side with your photo and number', camera: 'environment' },
  { kind: 'id_back', label: 'ID card, back', hint: 'The other side of the card', camera: 'environment' },
];

/** Phone photos are several MB. Shrink to 1600px JPEG so uploads are quick and stay under the size limit. */
async function decode(file: File): Promise<{ src: CanvasImageSource; w: number; h: number }> {
  try { const b = await createImageBitmap(file, { imageOrientation: 'from-image' }); return { src: b, w: b.width, h: b.height }; } catch { /* fall back to an <img> element */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
}
async function shrink(file: File): Promise<{ name: string; mimeType: string; dataBase64: string }> {
  if (file.type && !file.type.startsWith('image/')) throw new Error('Please choose a photo (an image file)');
  let img; try { img = await decode(file); } catch { throw new Error('This photo format is not supported by your browser (iPhone HEIC photos can cause this). Use "Take photo", or choose a JPEG or PNG.'); }
  const scale = Math.min(1, 1600 / Math.max(img.w, img.h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.w * scale)); c.height = Math.max(1, Math.round(img.h * scale));
  const g = c.getContext('2d'); if (!g) throw new Error('Could not read that image');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img.src, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { name: `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, mimeType: 'image/jpeg', dataBase64: url.split(',')[1] ?? '' };
}

/** The image behind a stored file id. Fetched with the login token, so it is shown from a blob URL. */
function useFileUrl(fileId: string | null | undefined, version = 0) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    setSrc('');
    if (!fileId) return;
    let url = ''; let dead = false;
    (async () => {
      const t = getToken();
      const res = await fetch(`/api/files/${fileId}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      if (res.ok && !dead) { url = URL.createObjectURL(await res.blob()); setSrc(url); }
    })().catch(() => undefined);
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [fileId, version]);
  return src;
}

const PHOTO_EVENT = 'member-photo-changed';

/** Round profile photo, or the member's initials when there is none yet. */
export function Avatar({ fileId, name, size = 40 }: { fileId?: string | null; name?: string | null; size?: number }) {
  const [v, setV] = useState(0);
  useEffect(() => { const f = () => setV((x) => x + 1); window.addEventListener(PHOTO_EVENT, f); return () => window.removeEventListener(PHOTO_EVENT, f); }, []);
  const src = useFileUrl(fileId, v);
  const initials = (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return src
    ? <img src={src} alt={name ?? 'Profile photo'} style={{ width: size, height: size }} className="shrink-0 rounded-full border border-slate-200 object-cover" />
    : <div style={{ width: size, height: size, fontSize: size * 0.38 }} className="flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-800" aria-hidden>{initials}</div>;
}

/** The signed-in member's photo id, refreshed whenever a new photo is uploaded. */
export function useMyPhotoId(): string | null {
  const { data, reload } = useApi<Record<Kind, string | null>>('/me/documents');
  useEffect(() => { const f = () => { void reload(); }; window.addEventListener(PHOTO_EVENT, f); return () => window.removeEventListener(PHOTO_EVENT, f); }, [reload]);
  return data?.photo ?? null;
}

/** Header showing the signed-in member's photo and name. */
export function MemberHeaderIdentity({ name, extra }: { name: string; extra: string }) {
  const photo = useMyPhotoId();
  return <span className="flex items-center gap-2 text-sm text-slate-600"><Avatar fileId={photo} name={name} size={36} /><span className="hidden sm:block">{name}<span className="text-slate-400">{extra}</span></span></span>;
}

function Thumb({ fileId }: { fileId: string }) {
  const src = useFileUrl(fileId);
  const [open, setOpen] = useState(false);
  if (!src) return <div className="flex h-40 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-500">Loading…</div>;
  return (<>
    <img src={src} alt="" className="h-40 w-full cursor-zoom-in rounded-lg bg-slate-100 object-contain" onClick={() => setOpen(true)} />
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setOpen(false)}><img src={src} alt="" className="max-h-full max-w-full rounded-lg" /></div>}
  </>);
}

/** Photo and ID card images. Members add what is missing; administrators can replace or remove. */
export function MemberDocuments({ mode, memberId }: { mode: 'member' | 'admin'; memberId?: string }) {
  const base = mode === 'member' ? '/me/documents' : `/members/${memberId}/documents`;
  const { data, loading, reload } = useApi<Record<Kind, string | null>>(base);
  const { me } = useAuth();
  const canEdit = mode === 'member' || ['super_admin', 'chairperson', 'secretary'].includes(me?.role ?? '');
  const canRemove = mode === 'admin' && me?.role === 'super_admin';
  const act = useAction();
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const have = SLOTS.filter((s) => data[s.kind]).length;
  const upload = (kind: Kind, replace: boolean) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
    await act.run(async () => { const body = await shrink(file); await api(mode === 'member' ? 'POST' : 'PUT', mode === 'member' ? `${base}/${kind}` : `${base}/${kind}`, body); await reload(); if (kind === 'photo' && mode === 'member') window.dispatchEvent(new Event(PHOTO_EVENT)); return true; }, replace ? 'Replaced' : 'Uploaded');
  };
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-brand-900">Photo and ID card</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${have === 3 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{have} of 3 uploaded</span>
      </div>
      {mode === 'member' && <p className="text-sm text-slate-600">Upload a clear photo of yourself and of both sides of your ID card. Once an image is uploaded only the administrator can replace it, so check it is clear and readable first.</p>}
      <ErrorBox msg={act.error} />
      {act.ok && !act.error && <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">{act.ok}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {SLOTS.map((s) => (
          <div key={s.kind} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="text-sm font-semibold">{s.label}</div>
            {data[s.kind] ? <Thumb fileId={data[s.kind]!} /> : <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-300 px-2 text-center text-xs text-slate-500">{s.hint}</div>}
            <input ref={(el) => { refs.current[s.kind] = el; }} type="file" accept="image/*" hidden onChange={upload(s.kind, Boolean(data[s.kind]))} />
            <input ref={(el) => { refs.current[`${s.kind}_cam`] = el; }} type="file" accept="image/*" capture={s.camera} hidden onChange={upload(s.kind, Boolean(data[s.kind]))} />
            <div className="flex flex-wrap gap-2">
              {canEdit && (!data[s.kind] || mode === 'admin') && <>
                <button className="btn-primary" disabled={act.busy} onClick={() => refs.current[`${s.kind}_cam`]?.click()}>{act.busy ? 'Uploading…' : '📷 Take photo'}</button>
                <button className="btn-ghost" disabled={act.busy} onClick={() => refs.current[s.kind]?.click()}>{data[s.kind] ? 'Replace from files' : 'Choose from gallery'}</button></>}
              {canRemove && data[s.kind] && <button className="text-xs text-red-700 underline" onClick={() => { if (confirm(`Remove ${s.label.toLowerCase()}?`)) void act.run(async () => { await api('DELETE', `${base}/${s.kind}`); await reload(); return true; }, 'Removed'); }}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
