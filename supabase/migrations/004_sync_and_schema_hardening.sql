-- ============================================================================
-- Migration 004: Multi-User Realtime Sync & Missing Column Hardening
-- Idempotent & Zero-Data-Loss: Safe to run on top of schema.sql + 002 + 003
-- Keeps RLS strictly enabled on ALL tables; zero permissive USING (true).
-- ============================================================================

-- 1. Ensure work_schedules has all required approval, shift & versioning columns
-- (Fixes "Could not find the 'approved_at' column of 'work_schedules' in the schema cache"
--  when work_schedules existed prior to schema.sql)
ALTER TABLE public.work_schedules
  ADD COLUMN IF NOT EXISTS approved_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS shift_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_day_off BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_approved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';

-- Useful indexes for fast filtered queries & lower DB I/O
CREATE INDEX IF NOT EXISTS idx_work_schedules_updated_at
  ON public.work_schedules (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_schedules_status
  ON public.work_schedules (status, work_date);

-- 2. Ensure REPLICA IDENTITY FULL on all tables participating in multi-user Realtime sync
ALTER TABLE public.user_profiles REPLICA IDENTITY FULL;
ALTER TABLE public.user_access REPLICA IDENTITY FULL;
ALTER TABLE public.barcode_scans REPLICA IDENTITY FULL;
ALTER TABLE public.work_schedules REPLICA IDENTITY FULL;
ALTER TABLE public.activity_logs REPLICA IDENTITY FULL;
ALTER TABLE public.system_settings REPLICA IDENTITY FULL;
ALTER TABLE public.shift_definitions REPLICA IDENTITY FULL;
ALTER TABLE public.attendance_logs REPLICA IDENTITY FULL;
ALTER TABLE public.customer_feedbacks REPLICA IDENTITY FULL;
ALTER TABLE public.product_catalog REPLICA IDENTITY FULL;
ALTER TABLE public.supplier_policies REPLICA IDENTITY FULL;
ALTER TABLE public.expiry_tracking REPLICA IDENTITY FULL;
ALTER TABLE public.return_records REPLICA IDENTITY FULL;
ALTER TABLE public.promotions REPLICA IDENTITY FULL;

-- 3. Ensure ALL 14 operational tables are published to supabase_realtime
-- so changes by any user (catalog, policies, profiles, settings, shifts, schedules, etc.)
-- propagate to all connected team members immediately.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'user_profiles',
    'user_access',
    'barcode_scans',
    'work_schedules',
    'activity_logs',
    'system_settings',
    'shift_definitions',
    'attendance_logs',
    'customer_feedbacks',
    'product_catalog',
    'supplier_policies',
    'expiry_tracking',
    'return_records',
    'promotions'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$$;

-- 4. Refresh PostgREST schema cache so newly added columns (e.g. approved_at) are visible immediately
NOTIFY pgrst, 'reload schema';
