import 'dotenv/config';

// Migration/seed scripts only need the database, so they must not fail on app-only secrets.
const dbTool = /db[\\/](migrate|seed|rekey|reset-records)/.test(process.argv[1] ?? '');

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if ((v === undefined || v === '') && dbTool && name !== 'DATABASE_URL') return fallback ?? 'unused-by-db-tools'.padEnd(64, '0');
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL', isProd ? undefined : 'postgres://savings:savings@localhost:5432/savings_dev'),
  jwtSecret: required('JWT_SECRET', isProd ? undefined : 'dev-only-jwt-secret-change-me-0123456789'),
  // Optional in production so the app can be deployed first; features that store National IDs stay disabled until it is set.
  fieldKey: process.env.FIELD_ENCRYPTION_KEY || (isProd ? '' : '0000000000000000000000000000000000000000000000000000000000000000'),
  groupName: process.env.GROUP_NAME ?? 'Friends Self Help Group',
  groupMotto: process.env.GROUP_MOTTO ?? 'For us and the society',
  // Printed in the letterhead of official forms. Left blank, the form shows a line to write on.
  groupRegNo: process.env.GROUP_REG_NO ?? '',
  groupAddress: process.env.GROUP_ADDRESS ?? 'Embu, Kenya',
  groupTel: process.env.GROUP_TEL ?? '',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:8080',
  mpesa: {
    env: process.env.MPESA_ENV ?? 'sandbox',
    consumerKey: process.env.MPESA_CONSUMER_KEY ?? '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET ?? '',
    shortcode: process.env.MPESA_SHORTCODE ?? '',
    passkey: process.env.MPESA_PASSKEY ?? '',
    transactionType: process.env.MPESA_TRANSACTION_TYPE ?? 'CustomerPayBillOnline', // or CustomerBuyGoodsOnline for a Till
    till: process.env.MPESA_TILL ?? '',
    // Safaricom does not sign callbacks, so the URL itself carries an unguessable secret.
    callbackSecret: process.env.MPESA_CALLBACK_SECRET ?? '',
  },
  sms: {
    username: process.env.AT_USERNAME ?? '',
    apiKey: process.env.AT_API_KEY ?? '',
    senderId: process.env.AT_SENDER_ID ?? '',
  },
};

if (isProd && !dbTool && config.fieldKey && config.fieldKey.length !== 64) {
  throw new Error('FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
}
