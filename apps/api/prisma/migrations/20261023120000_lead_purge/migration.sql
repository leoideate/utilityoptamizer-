-- Administrators can permanently delete leads nobody has worked on (OpportunitiesService.purgeLeads).
-- Like the retention purge, that runs with uo.allow_purge set for its transaction; every other
-- delete is still refused, and `active` still can't be switched off.
CREATE OR REPLACE FUNCTION uo_protect_opportunity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('uo.allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Opportunities are permanent records and cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.active = false THEN
    RAISE EXCEPTION 'Opportunities cannot be archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
