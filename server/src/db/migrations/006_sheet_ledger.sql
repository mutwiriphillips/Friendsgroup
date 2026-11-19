-- 006: spreadsheet-style member ledger (members x months), editable with every change logged.
ALTER TABLE savings_transactions ADD COLUMN period date CHECK (period IS NULL OR period = date_trunc('month', period)::date);
CREATE INDEX savings_period_idx ON savings_transactions(member_id, period) WHERE period IS NOT NULL;

ALTER TABLE fines ADD COLUMN period date CHECK (period IS NULL OR period = date_trunc('month', period)::date);
ALTER TABLE meetings ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN sheet_order int;

-- Historical late fines come from the sheet and have no obligation behind them.
ALTER TABLE fines DROP CONSTRAINT fines_check;
ALTER TABLE fines ADD CONSTRAINT fines_late_needs_obligation CHECK (category <> 'late_payment' OR obligation_id IS NOT NULL OR is_historical);
CREATE UNIQUE INDEX fines_one_historical_late_per_month ON fines(member_id, period)
  WHERE category = 'late_payment' AND obligation_id IS NULL AND status <> 'reversed';
