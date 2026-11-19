import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

const BASE = () => (config.mpesa.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

type FetchFn = typeof fetch;
let fetchImpl: FetchFn = (...args) => fetch(...args);
/** Test hook: swap the HTTP client so tests never call Safaricom. */
export function setMpesaFetch(fn: FetchFn | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

export function mpesaConfigured(): boolean {
  const m = config.mpesa;
  return Boolean(m.consumerKey && m.consumerSecret && m.shortcode && m.passkey && m.callbackSecret && config.appBaseUrl.startsWith('https://'));
}

export function stkCallbackUrl(): string {
  return `${config.appBaseUrl}/api/mpesa/stk-callback/${config.mpesa.callbackSecret}`;
}
export function c2bUrls(): { confirmation: string; validation: string } {
  return {
    confirmation: `${config.appBaseUrl}/api/mpesa/c2b-confirmation/${config.mpesa.callbackSecret}`,
    validation: `${config.appBaseUrl}/api/mpesa/c2b-validation/${config.mpesa.callbackSecret}`,
  };
}

let cached: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;
  const auth = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString('base64');
  const res = await fetchImpl(`${BASE()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new HttpError(502, 'Could not authenticate with M-Pesa');
  const json = (await res.json()) as { access_token: string; expires_in: string };
  cached = { token: json.access_token, expires: Date.now() + Number(json.expires_in) * 1000 };
  return cached.token;
}

function timestampEAT(): string {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
function password(ts: string): string {
  return Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${ts}`).toString('base64');
}

export interface StkResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage: string;
}

/** Sends the STK prompt. A successful response only means the prompt was sent, NOT that money moved. */
export async function stkPush(input: { phone: string; amountKes: number; accountRef: string; description: string }): Promise<StkResult> {
  if (!mpesaConfigured()) throw new HttpError(503, 'M-Pesa payments are not configured yet. Please use manual submission.');
  if (!Number.isInteger(input.amountKes) || input.amountKes < 1) throw new HttpError(400, 'M-Pesa amounts must be whole shillings');
  const ts = timestampEAT();
  const res = await fetchImpl(`${BASE()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: config.mpesa.shortcode,
      Password: password(ts),
      Timestamp: ts,
      TransactionType: config.mpesa.transactionType,
      Amount: input.amountKes,
      PartyA: input.phone,
      PartyB: config.mpesa.till || config.mpesa.shortcode,
      PhoneNumber: input.phone,
      CallBackURL: stkCallbackUrl(),
      AccountReference: input.accountRef.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || json.ResponseCode !== '0') {
    throw new HttpError(502, json.errorMessage || json.ResponseDescription || 'M-Pesa rejected the request');
  }
  return { merchantRequestId: json.MerchantRequestID!, checkoutRequestId: json.CheckoutRequestID!, customerMessage: json.CustomerMessage ?? '' };
}

/** Ask Safaricom for the outcome of a prompt whose callback has not arrived. */
export async function stkQuery(checkoutRequestId: string): Promise<{ resultCode: number; resultDesc: string }> {
  if (!mpesaConfigured()) throw new HttpError(503, 'M-Pesa payments are not configured');
  const ts = timestampEAT();
  const res = await fetchImpl(`${BASE()}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: config.mpesa.shortcode, Password: password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (json.ResultCode === undefined) throw new HttpError(502, json.errorMessage || 'Transaction is still being processed');
  return { resultCode: Number(json.ResultCode), resultDesc: json.ResultDesc ?? '' };
}

/** One-time registration of Paybill/Till C2B URLs (run by the super admin). */
export async function registerC2bUrls(): Promise<unknown> {
  if (!mpesaConfigured()) throw new HttpError(503, 'M-Pesa payments are not configured');
  const urls = c2bUrls();
  const res = await fetchImpl(`${BASE()}/mpesa/c2b/v1/registerurl`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ShortCode: config.mpesa.shortcode, ResponseType: 'Completed', ConfirmationURL: urls.confirmation, ValidationURL: urls.validation }),
  });
  return res.json();
}
