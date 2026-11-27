-- ============================================================================
-- Migration 004: Multi-User Realtime Sync & Missing Column Hardening
-- Idempotent & Zero-Data-Loss: Safe to run on top of schema.sql + 002 + 003
-- Keeps RLS strictly enabled on ALL tables; zero permissive USING (true).
-- ============================================================================

-- 1. Ensure barcode_scans has all required tracking & versioning columns
-- (Fixes "column barcode_scans.version does not exist" on pre-migration tables)
ALTER TABLE public.barcode_scans
  ADD COLUMN IF NOT EXISTS session_name TEXT NOT NULL DEFAULT 'Mặc định',
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_barcode_scans_owner_email
  ON public.barcode_scans (owner_email);
CREATE INDEX IF NOT EXISTS idx_barcode_scans_updated_at
  ON public.barcode_scans (updated_at DESC);

-- 2. Ensure work_schedules has all required approval, shift & versioning columns
-- (Fixes "Could not find the 'approved_at' column of 'work_schedules' in the schema cache")
ALTER TABLE public.work_schedules
  ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS approved_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS shift_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_day_off BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_approved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Useful indexes for fast filtered queries & lower DB I/O
CREATE INDEX IF NOT EXISTS idx_work_schedules_updated_at
  ON public.work_schedules (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_schedules_status
  ON public.work_schedules (status, work_date);

-- 3. Ensure user_access & activity_logs have all expected columns
ALTER TABLE public.user_access
  ADD COLUMN IF NOT EXISTS scope_all BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_export BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS activity_view BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_supabase BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS module_perms JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS granted_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.activity_logs
  ADD COLUMN IF NOT EXISTS actor_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS actor_role TEXT NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS target_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 4. Ensure REPLICA IDENTITY FULL & supabase_realtime publication on all existing tables
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
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = v_table
    ) THEN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', v_table);

      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END IF;
  END LOOP;
END
$$;

-- 5. Refresh PostgREST schema cache so newly added columns (version, updated_by, approved_at, etc.) are visible immediately
NOTIFY pgrst, 'reload schema';
