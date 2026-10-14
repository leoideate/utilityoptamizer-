-- Integrity rules that Prisma's schema language can't express.

-- Audit log and timeline are append-only: entries can't be edited or deleted silently.
-- (Retention purges run as the table owner with uo.allow_purge set; see RetentionService.)
CREATE OR REPLACE FUNCTION uo_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('uo.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

CREATE TRIGGER timeline_entries_append_only
  BEFORE UPDATE OR DELETE ON timeline_entries
  FOR EACH ROW EXECUTE FUNCTION uo_block_mutation();

-- Opportunities are permanent: they may not be deleted, and `active` may not be switched off.
CREATE OR REPLACE FUNCTION uo_protect_opportunity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Opportunities are permanent records and cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.active = false THEN
    RAISE EXCEPTION 'Opportunities cannot be archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER opportunities_permanent
  BEFORE UPDATE OR DELETE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION uo_protect_opportunity();

-- At most one OPEN automation reminder per opportunity and key.
CREATE UNIQUE INDEX activities_open_automation_key
  ON activities (opportunity_id, automation_key)
  WHERE status = 'open' AND automation_key IS NOT NULL;

-- Percentages stay within 0-100 even if written outside the API.
ALTER TABLE merchant_applications ADD CONSTRAINT merchant_card_pct_range CHECK (card_turnover_pct IS NULL OR card_turnover_pct BETWEEN 0 AND 100);
ALTER TABLE merchant_risk ADD CONSTRAINT risk_deposit_txn_pct_range CHECK (deposit_txn_pct IS NULL OR deposit_txn_pct BETWEEN 0 AND 100);
ALTER TABLE merchant_risk ADD CONSTRAINT risk_deposit_value_pct_range CHECK (deposit_value_pct IS NULL OR deposit_value_pct BETWEEN 0 AND 100);
ALTER TABLE merchant_risk ADD CONSTRAINT risk_prepayment_pct_range CHECK (full_prepayment_pct IS NULL OR full_prepayment_pct BETWEEN 0 AND 100);
ALTER TABLE principals ADD CONSTRAINT principal_ownership_pct_range CHECK (ownership_pct IS NULL OR ownership_pct BETWEEN 0 AND 100);
ALTER TABLE merchant_pricing ADD CONSTRAINT pricing_rates_range CHECK (
  (debit_rate IS NULL OR debit_rate BETWEEN 0 AND 100) AND (credit_rate IS NULL OR credit_rate BETWEEN 0 AND 100) AND
  (commercial_rate IS NULL OR commercial_rate BETWEEN 0 AND 100) AND (amex_rate IS NULL OR amex_rate BETWEEN 0 AND 100));
ALTER TABLE opportunities ADD CONSTRAINT opportunity_probability_range CHECK (probability BETWEEN 0 AND 100);
