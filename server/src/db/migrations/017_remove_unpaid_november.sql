-- Under the new rule November's contributions fall due on 10 December and the administrator marks them paid or unpaid.
-- Remove the automatically raised, still-unpaid invoices for November 2026 onward. Paid invoices, anything an
-- administrator has allocated money to, and anything with a fine attached are left untouched.
DO $$
DECLARE removed integer;
BEGIN
  ALTER TABLE monthly_obligations DISABLE TRIGGER obligations_no_delete;
  WITH gone AS (
    DELETE FROM monthly_obligations o
     WHERE o.period >= DATE '2026-11-01'
       AND o.status IN ('not_due', 'unpaid', 'overdue')
       AND o.paid_cents = 0
       AND NOT o.is_historical
       AND NOT EXISTS (SELECT 1 FROM savings_allocations a WHERE a.obligation_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM fines f WHERE f.obligation_id = o.id)
    RETURNING o.id
  )
  SELECT count(*) INTO removed FROM gone;
  ALTER TABLE monthly_obligations ENABLE TRIGGER obligations_no_delete;
  IF removed > 0 THEN
    INSERT INTO audit_logs (user_role, action, entity_type, reason, after)
    VALUES ('system', 'invoices.removed', 'monthly_obligations',
            'Contributions now fall due on the deadline day of the following month; administrator manages paid/unpaid',
            jsonb_build_object('count', removed, 'from_period', '2026-11-01'));
  END IF;
END $$;
