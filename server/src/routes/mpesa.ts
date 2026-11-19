import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { withTx } from '../db/pool.js';
import { h } from '../lib/http.js';
import { processC2B, processStkCallback } from '../services/payments.js';
import { registerC2bUrls, c2bUrls, stkCallbackUrl, mpesaConfigured } from '../services/mpesa.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

/** Public endpoints called by Safaricom. Protected by an unguessable path secret. */
export const mpesaCallbackRouter = Router();

function secretOk(given: string): boolean {
  const want = Buffer.from(config.mpesa.callbackSecret);
  const got = Buffer.from(given);
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

mpesaCallbackRouter.post(
  '/stk-callback/:secret',
  h(async (req, res) => {
    if (!secretOk(String(req.params.secret))) {
      res.status(404).end();
      return;
    }
    try {
      await withTx((c) => processStkCallback(c, req.body));
    } catch (err) {
      console.error('stk callback failed', err);
      // Still acknowledge: our own reconciliation (status query / treasurer) recovers the payment.
    }
    res.json(ACK);
  }),
);

mpesaCallbackRouter.post(
  '/c2b-validation/:secret',
  h(async (req, res) => {
    if (!secretOk(String(req.params.secret))) {
      res.status(404).end();
      return;
    }
    res.json(ACK); // accept everything; unmatched money is held for the treasurer
  }),
);

mpesaCallbackRouter.post(
  '/c2b-confirmation/:secret',
  h(async (req, res) => {
    if (!secretOk(String(req.params.secret))) {
      res.status(404).end();
      return;
    }
    try {
      await withTx((c) => processC2B(c, req.body));
    } catch (err) {
      console.error('c2b confirmation failed', err);
    }
    res.json(ACK);
  }),
);

/** Admin: show configuration status and register Paybill URLs. */
export const mpesaAdminRouter = Router();
mpesaAdminRouter.use(authenticate, requirePermission('mpesa.configure'));

mpesaAdminRouter.get('/status', (_req, res) => {
  res.json({
    configured: mpesaConfigured(),
    environment: config.mpesa.env,
    shortcode: config.mpesa.shortcode ? `${config.mpesa.shortcode.slice(0, 2)}****` : null,
    transactionType: config.mpesa.transactionType,
    stkCallbackUrl: config.mpesa.callbackSecret ? stkCallbackUrl().replace(config.mpesa.callbackSecret, '••••') : null,
    c2b: config.mpesa.callbackSecret ? Object.fromEntries(Object.entries(c2bUrls()).map(([k, v]) => [k, v.replace(config.mpesa.callbackSecret, '••••')])) : null,
    httpsBaseUrl: config.appBaseUrl.startsWith('https://'),
  });
});

mpesaAdminRouter.post('/register-c2b', h(async (_req, res) => res.json(await registerC2bUrls())));
