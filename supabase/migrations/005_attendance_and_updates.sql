-- ============================================================================
-- Migration 005: Attendance Real-Time Adjustments, Clear Time & Delete RLS
-- Safe, additive & idempotent — preserves all existing rows.
-- ============================================================================

-- 1. Allow 'clear_time' status on public.attendance_logs
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'attendance_logs'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.attendance_logs DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.attendance_logs
  ADD CONSTRAINT attendance_logs_status_check
  CHECK (status IN ('checked_in', 'checked_out', 'early_leave', 'overtime', 'clear_time'));

-- 2. Update enforce_attendance_integrity():
--    - On INSERT: stamp real-time NOW() on server at button-press time
--    - On UPDATE: allow adjusting check_in_at, check_out_at (including NULL for clear_time),
--                 work_date, shift_name, employee_name, status while preserving created_at
CREATE OR REPLACE FUNCTION public.enforce_attendance_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_dup_count INT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.check_in_at := NOW();
    NEW.created_at := NOW();
    NEW.updated_at := NOW();
    NEW.owner_email := LOWER(TRIM(NEW.owner_email));

    SELECT COUNT(*) INTO v_dup_count
    FROM public.attendance_logs a
    WHERE LOWER(a.owner_email) = NEW.owner_email
      AND a.work_date = NEW.work_date
      AND (
        (NEW.schedule_id IS NOT NULL AND a.schedule_id = NEW.schedule_id)
        OR (NEW.schedule_id IS NULL AND a.shift_name = NEW.shift_name AND a.status = 'checked_in')
      );

    IF v_dup_count > 0 THEN
      RAISE EXCEPTION 'Bạn đã chấm công cho ca này trong ngày % rồi.', NEW.work_date;
    END IF;
    RETURN NEW;
  END IF;

  -- On UPDATE: preserve created_at & original owner, allow adjusting attendance fields
  NEW.created_at := OLD.created_at;
  NEW.updated_at := NOW();
  NEW.owner_email := LOWER(TRIM(COALESCE(NEW.owner_email, OLD.owner_email)));
  IF NEW.check_in_at IS NULL THEN
    NEW.check_in_at := OLD.check_in_at;
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Allow Shift Leads+ or record owners with active access to delete attendance logs
DROP POLICY IF EXISTS "Attendance delete" ON public.attendance_logs;
CREATE POLICY "Attendance delete"
  ON public.attendance_logs FOR DELETE
  TO authenticated
  USING (
    public.is_lead_or_above()
    OR (
      public.has_active_access()
      AND (
        LOWER(TRIM(owner_email)) = public.current_user_email()
        OR owner_id = auth.uid()::text
      )
    )
  );
