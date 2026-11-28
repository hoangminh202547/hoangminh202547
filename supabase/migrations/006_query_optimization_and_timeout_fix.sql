-- ============================================================================
-- Migration 006: Query Optimization, Missing Indexes & Statement Timeout Fix
-- Idempotent & Zero-Data-Loss: Safe to run on top of schema.sql + 002..005.
-- Keeps strict RBAC & RLS enabled on ALL tables (zero USING (true)).
-- Fixes: "canceling statement due to statement timeout" (SQLSTATE 57014).
-- ============================================================================

-- 1. Enable trigram extension for fast %substring% ILIKE searches
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping pg_trgm extension creation due to privileges.';
END $$;

-- 2. Safely raise authenticated statement_timeout (only if role privilege permits)
DO $$
BEGIN
  EXECUTE 'ALTER ROLE authenticated SET statement_timeout = ''20s''';
  EXECUTE 'ALTER ROLE anon SET statement_timeout = ''8s''';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping role-level statement_timeout change due to privileges.';
END $$;

-- 3. Functional & B-Tree indexes for RLS lookups, email matching, sorting & triggers
CREATE INDEX IF NOT EXISTS idx_user_access_lower_trim_email
  ON public.user_access (LOWER(TRIM(email)));
CREATE INDEX IF NOT EXISTS idx_user_access_active_email
  ON public.user_access (LOWER(TRIM(email)))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_user_profiles_lower_trim_email
  ON public.user_profiles (LOWER(TRIM(email)));
CREATE INDEX IF NOT EXISTS idx_user_profiles_display_name
  ON public.user_profiles (display_name ASC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_avatar_nonempty
  ON public.user_profiles (avatar_path)
  WHERE avatar_path <> '';

CREATE INDEX IF NOT EXISTS idx_barcode_scans_lower_trim_owner_email
  ON public.barcode_scans (LOWER(TRIM(owner_email)));
CREATE INDEX IF NOT EXISTS idx_barcode_scans_owner_id
  ON public.barcode_scans (owner_id);
CREATE INDEX IF NOT EXISTS idx_barcode_scans_updated_at
  ON public.barcode_scans (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_schedules_lower_trim_owner_email
  ON public.work_schedules (LOWER(TRIM(owner_email)));
CREATE INDEX IF NOT EXISTS idx_work_schedules_owner_id
  ON public.work_schedules (owner_id);
CREATE INDEX IF NOT EXISTS idx_work_schedules_work_date_start
  ON public.work_schedules (work_date ASC, start_time ASC);
CREATE INDEX IF NOT EXISTS idx_work_schedules_day_off_owner_date
  ON public.work_schedules (LOWER(TRIM(owner_email)), work_date)
  WHERE is_day_off = true AND status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_work_schedules_day_off_date
  ON public.work_schedules (work_date)
  WHERE is_day_off = true AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_attendance_lower_trim_owner_email
  ON public.attendance_logs (LOWER(TRIM(owner_email)), work_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_owner_id
  ON public.attendance_logs (owner_id);
CREATE INDEX IF NOT EXISTS idx_attendance_schedule_id
  ON public.attendance_logs (schedule_id)
  WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_work_date_checkin
  ON public.attendance_logs (work_date DESC, check_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_lower_trim_owner_date
  ON public.customer_feedbacks (LOWER(TRIM(owner_email)), feedback_date);
CREATE INDEX IF NOT EXISTS idx_feedback_created_asc
  ON public.customer_feedbacks (created_at ASC);
CREATE INDEX IF NOT EXISTS idx_feedback_image_nonempty
  ON public.customer_feedbacks (image_path)
  WHERE image_path <> '';
CREATE INDEX IF NOT EXISTS idx_feedback_thumb_nonempty
  ON public.customer_feedbacks (image_thumb_path)
  WHERE image_thumb_path <> '';

CREATE INDEX IF NOT EXISTS idx_activity_logs_lower_trim_actor_email
  ON public.activity_logs (LOWER(TRIM(actor_email)));
CREATE INDEX IF NOT EXISTS idx_activity_logs_actor_id
  ON public.activity_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
  ON public.activity_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_product_code_asc
  ON public.product_catalog (product_code ASC);
CREATE INDEX IF NOT EXISTS idx_policies_supplier_system_asc
  ON public.supplier_policies (supplier_system_name ASC);
CREATE INDEX IF NOT EXISTS idx_expiry_exp_date_asc
  ON public.expiry_tracking (exp_date ASC);
CREATE INDEX IF NOT EXISTS idx_returns_updated_at_desc
  ON public.return_records (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_promotions_status_badge_exp
  ON public.promotions (status, has_b_badge, exp_date ASC);

-- 4. GIN Trigram indexes for fast %substring% ILIKE search across operational tables
DO $$
BEGIN
  SET LOCAL search_path = public, extensions;

  CREATE INDEX IF NOT EXISTS idx_catalog_product_code_trgm
    ON public.product_catalog USING gin (product_code gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_catalog_barcode_trgm
    ON public.product_catalog USING gin (barcode gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_catalog_name_trgm
    ON public.product_catalog USING gin (name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_catalog_supplier_trgm
    ON public.product_catalog USING gin (supplier_name gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_policies_sup_sys_trgm
    ON public.supplier_policies USING gin (supplier_system_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_policies_sup_name_trgm
    ON public.supplier_policies USING gin (supplier_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_policies_prod_name_trgm
    ON public.supplier_policies USING gin (product_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_policies_category_trgm
    ON public.supplier_policies USING gin (category gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_expiry_code_trgm
    ON public.expiry_tracking USING gin (product_code gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_expiry_barcode_trgm
    ON public.expiry_tracking USING gin (barcode gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_expiry_name_trgm
    ON public.expiry_tracking USING gin (product_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_expiry_sup_trgm
    ON public.expiry_tracking USING gin (supplier_system_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_expiry_pt_trgm
    ON public.expiry_tracking USING gin (pt_code gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_returns_sup_trgm
    ON public.return_records USING gin (supplier_system_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_returns_summary_trgm
    ON public.return_records USING gin (product_summary gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_returns_method_trgm
    ON public.return_records USING gin (return_method gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_returns_pt_trgm
    ON public.return_records USING gin (pt_code gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_promotions_code_trgm
    ON public.promotions USING gin (product_code gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_promotions_barcode_trgm
    ON public.promotions USING gin (barcode gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_promotions_name_trgm
    ON public.promotions USING gin (product_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_promotions_pt_trgm
    ON public.promotions USING gin (pt_code gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_attendance_emp_trgm
    ON public.attendance_logs USING gin (employee_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_attendance_email_trgm
    ON public.attendance_logs USING gin (owner_email gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_attendance_shift_trgm
    ON public.attendance_logs USING gin (shift_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_attendance_work_date_trgm
    ON public.attendance_logs USING gin (work_date gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_feedback_date_trgm
    ON public.customer_feedbacks USING gin (feedback_date gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_feedback_owner_trgm
    ON public.customer_feedbacks USING gin (owner_email gin_trgm_ops);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Skipping GIN trigram index creation (%).', SQLERRM;
END $$;

-- 5. Fast STABLE SECURITY DEFINER helper to evaluate per-module permissions once per statement
CREATE OR REPLACE FUNCTION public.has_user_perm(
  p_perm TEXT,
  p_require_scope_all BOOLEAN DEFAULT false
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND (
          (p_perm = 'barcode_view' AND ua.barcode_view = true)
          OR (p_perm = 'barcode_create' AND ua.barcode_create = true)
          OR (p_perm = 'barcode_edit' AND ua.barcode_edit = true)
          OR (p_perm = 'barcode_delete' AND ua.barcode_delete = true)
          OR (p_perm = 'schedule_view' AND ua.schedule_view = true)
          OR (p_perm = 'schedule_create' AND ua.schedule_create = true)
          OR (p_perm = 'schedule_update' AND (ua.schedule_edit = true OR ua.schedule_approve = true))
          OR (p_perm = 'schedule_delete' AND ua.schedule_delete = true)
          OR (p_perm = 'activity_view' AND (ua.activity_view = true OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')))
        )
        AND (
          NOT p_require_scope_all
          OR ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
        )
    );
$$;

-- 6. Rebuild RLS policies using PostgreSQL InitPlan pattern (SELECT fn())
--    so auth/role checks evaluate ONCE per query instead of per scanned row.

-- A. user_profiles
DROP POLICY IF EXISTS "Profiles read active team" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles insert own" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles update own" ON public.user_profiles;

CREATE POLICY "Profiles read active team"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR LOWER(TRIM(email)) = (SELECT public.current_user_email())
    OR (SELECT public.has_active_access())
  );

CREATE POLICY "Profiles insert own"
  ON public.user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    id = (SELECT auth.uid())
    AND LOWER(TRIM(email)) = (SELECT public.current_user_email())
  );

CREATE POLICY "Profiles update own"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (
    id = (SELECT auth.uid())
    AND LOWER(TRIM(email)) = (SELECT public.current_user_email())
  );

-- B. user_access
DROP POLICY IF EXISTS "Access read own or manager" ON public.user_access;
DROP POLICY IF EXISTS "Access insert store_manager only" ON public.user_access;
DROP POLICY IF EXISTS "Access update store_manager only" ON public.user_access;
DROP POLICY IF EXISTS "Access delete store_manager only" ON public.user_access;

CREATE POLICY "Access read own or manager"
  ON public.user_access FOR SELECT
  TO authenticated
  USING (
    LOWER(TRIM(email)) = (SELECT public.current_user_email())
    OR (SELECT public.is_store_manager())
  );

CREATE POLICY "Access insert store_manager only"
  ON public.user_access FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_store_manager()));

CREATE POLICY "Access update store_manager only"
  ON public.user_access FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_store_manager()))
  WITH CHECK ((SELECT public.is_store_manager()));

CREATE POLICY "Access delete store_manager only"
  ON public.user_access FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_store_manager())
    AND LOWER(TRIM(email)) <> 'hoangminh202547@gmail.com'
  );

-- C. barcode_scans (Zero per-row correlated EXISTS!)
DROP POLICY IF EXISTS "Barcode select by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode insert by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode update by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode delete by permission" ON public.barcode_scans;

CREATE POLICY "Barcode select by permission"
  ON public.barcode_scans FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('barcode_view', true))
    OR (
      (SELECT public.has_user_perm('barcode_view', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Barcode insert by permission"
  ON public.barcode_scans FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      (SELECT public.is_super_admin())
      OR (SELECT public.has_user_perm('barcode_create', false))
    )
    AND (
      LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
      OR owner_id = (SELECT auth.uid()::text)
      OR (SELECT public.can_scope_all())
    )
  );

CREATE POLICY "Barcode update by permission"
  ON public.barcode_scans FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('barcode_edit', true))
    OR (
      (SELECT public.has_user_perm('barcode_edit', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  )
  WITH CHECK (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('barcode_edit', true))
    OR (
      (SELECT public.has_user_perm('barcode_edit', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Barcode delete by permission"
  ON public.barcode_scans FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('barcode_delete', true))
    OR (
      (SELECT public.has_user_perm('barcode_delete', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

-- D. work_schedules (Zero per-row correlated EXISTS!)
DROP POLICY IF EXISTS "Schedule select by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule insert by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule update by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule delete by permission" ON public.work_schedules;

CREATE POLICY "Schedule select by permission"
  ON public.work_schedules FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('schedule_view', true))
    OR (
      (SELECT public.has_user_perm('schedule_view', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Schedule insert by permission"
  ON public.work_schedules FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      (SELECT public.is_super_admin())
      OR (SELECT public.has_user_perm('schedule_create', false))
    )
    AND (
      LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
      OR owner_id = (SELECT auth.uid()::text)
      OR (SELECT public.can_scope_all())
    )
  );

CREATE POLICY "Schedule update by permission"
  ON public.work_schedules FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('schedule_update', true))
    OR (
      (SELECT public.has_user_perm('schedule_update', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  )
  WITH CHECK (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('schedule_update', true))
    OR (
      (SELECT public.has_user_perm('schedule_update', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Schedule delete by permission"
  ON public.work_schedules FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('schedule_delete', true))
    OR (
      (SELECT public.has_user_perm('schedule_delete', false))
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

-- E. activity_logs
DROP POLICY IF EXISTS "Activity select by permission" ON public.activity_logs;
DROP POLICY IF EXISTS "Activity insert by authenticated active user" ON public.activity_logs;

CREATE POLICY "Activity select by permission"
  ON public.activity_logs FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR (SELECT public.has_user_perm('activity_view', false))
    OR (
      (SELECT public.has_active_access())
      AND (
        LOWER(TRIM(actor_email)) = (SELECT public.current_user_email())
        OR actor_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Activity insert by authenticated active user"
  ON public.activity_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.has_active_access())
    AND (
      LOWER(TRIM(actor_email)) = (SELECT public.current_user_email())
      OR actor_id = (SELECT auth.uid()::text)
    )
  );

-- F. system_settings
DROP POLICY IF EXISTS "Settings read active" ON public.system_settings;
DROP POLICY IF EXISTS "Settings insert manager" ON public.system_settings;
DROP POLICY IF EXISTS "Settings update manager" ON public.system_settings;
DROP POLICY IF EXISTS "Settings delete manager" ON public.system_settings;

CREATE POLICY "Settings read active"
  ON public.system_settings FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Settings insert manager"
  ON public.system_settings FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_store_manager()));

CREATE POLICY "Settings update manager"
  ON public.system_settings FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_store_manager()))
  WITH CHECK ((SELECT public.is_store_manager()));

CREATE POLICY "Settings delete manager"
  ON public.system_settings FOR DELETE
  TO authenticated
  USING ((SELECT public.is_store_manager()));

-- G. shift_definitions
DROP POLICY IF EXISTS "Shifts read active" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts insert approver" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts update approver" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts delete approver" ON public.shift_definitions;

CREATE POLICY "Shifts read active"
  ON public.shift_definitions FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Shifts insert approver"
  ON public.shift_definitions FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_supervisor_or_manager())
    OR (SELECT public.can_approve_schedules())
  );

CREATE POLICY "Shifts update approver"
  ON public.shift_definitions FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_supervisor_or_manager())
    OR (SELECT public.can_approve_schedules())
  )
  WITH CHECK (
    (SELECT public.is_supervisor_or_manager())
    OR (SELECT public.can_approve_schedules())
  );

CREATE POLICY "Shifts delete approver"
  ON public.shift_definitions FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_supervisor_or_manager())
    OR (SELECT public.can_approve_schedules())
  );

-- H. attendance_logs (preserves Migration 005 delete rules)
DROP POLICY IF EXISTS "Attendance select" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance insert" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance update" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance delete" ON public.attendance_logs;

CREATE POLICY "Attendance select"
  ON public.attendance_logs FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_lead_or_above())
    OR (
      (SELECT public.has_active_access())
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Attendance insert"
  ON public.attendance_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.has_active_access())
    AND (
      LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
      OR owner_id = (SELECT auth.uid()::text)
      OR (SELECT public.is_store_manager())
    )
  );

CREATE POLICY "Attendance update"
  ON public.attendance_logs FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_lead_or_above())
    OR (
      (SELECT public.has_active_access())
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  )
  WITH CHECK (
    (SELECT public.is_lead_or_above())
    OR (
      (SELECT public.has_active_access())
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

CREATE POLICY "Attendance delete"
  ON public.attendance_logs FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_lead_or_above())
    OR (
      (SELECT public.has_active_access())
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

-- I. customer_feedbacks
DROP POLICY IF EXISTS "Feedback select" ON public.customer_feedbacks;
DROP POLICY IF EXISTS "Feedback insert" ON public.customer_feedbacks;
DROP POLICY IF EXISTS "Feedback delete" ON public.customer_feedbacks;

CREATE POLICY "Feedback select"
  ON public.customer_feedbacks FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Feedback insert"
  ON public.customer_feedbacks FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.has_active_access())
    AND (
      LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
      OR owner_id = (SELECT auth.uid()::text)
      OR (SELECT public.is_store_manager())
    )
  );

CREATE POLICY "Feedback delete"
  ON public.customer_feedbacks FOR DELETE
  TO authenticated
  USING (
    (SELECT public.is_supervisor_or_manager())
    OR (
      (SELECT public.has_active_access())
      AND (
        LOWER(TRIM(owner_email)) = (SELECT public.current_user_email())
        OR owner_id = (SELECT auth.uid()::text)
      )
    )
  );

-- J. product_catalog
DROP POLICY IF EXISTS "Catalog select" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog insert" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog update" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog delete" ON public.product_catalog;

CREATE POLICY "Catalog select"
  ON public.product_catalog FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Catalog insert"
  ON public.product_catalog FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_lead_or_above()));

CREATE POLICY "Catalog update"
  ON public.product_catalog FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_lead_or_above()))
  WITH CHECK ((SELECT public.is_lead_or_above()));

CREATE POLICY "Catalog delete"
  ON public.product_catalog FOR DELETE
  TO authenticated
  USING ((SELECT public.is_lead_or_above()));

-- K. supplier_policies
DROP POLICY IF EXISTS "Policies select" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies insert" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies update" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies delete" ON public.supplier_policies;

CREATE POLICY "Policies select"
  ON public.supplier_policies FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Policies insert"
  ON public.supplier_policies FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_lead_or_above()));

CREATE POLICY "Policies update"
  ON public.supplier_policies FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_lead_or_above()))
  WITH CHECK ((SELECT public.is_lead_or_above()));

CREATE POLICY "Policies delete"
  ON public.supplier_policies FOR DELETE
  TO authenticated
  USING ((SELECT public.is_lead_or_above()));

-- L. expiry_tracking
DROP POLICY IF EXISTS "Expiry select" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry insert" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry update" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry delete" ON public.expiry_tracking;

CREATE POLICY "Expiry select"
  ON public.expiry_tracking FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Expiry insert"
  ON public.expiry_tracking FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.has_active_access()));

CREATE POLICY "Expiry update"
  ON public.expiry_tracking FOR UPDATE
  TO authenticated
  USING ((SELECT public.has_active_access()))
  WITH CHECK ((SELECT public.has_active_access()));

CREATE POLICY "Expiry delete"
  ON public.expiry_tracking FOR DELETE
  TO authenticated
  USING ((SELECT public.is_supervisor_or_manager()));

-- M. return_records
DROP POLICY IF EXISTS "Returns select" ON public.return_records;
DROP POLICY IF EXISTS "Returns insert" ON public.return_records;
DROP POLICY IF EXISTS "Returns update" ON public.return_records;
DROP POLICY IF EXISTS "Returns delete" ON public.return_records;

CREATE POLICY "Returns select"
  ON public.return_records FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Returns insert"
  ON public.return_records FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.has_active_access()));

CREATE POLICY "Returns update"
  ON public.return_records FOR UPDATE
  TO authenticated
  USING ((SELECT public.has_active_access()))
  WITH CHECK ((SELECT public.has_active_access()));

CREATE POLICY "Returns delete"
  ON public.return_records FOR DELETE
  TO authenticated
  USING ((SELECT public.is_supervisor_or_manager()));

-- N. promotions
DROP POLICY IF EXISTS "Promotions select" ON public.promotions;
DROP POLICY IF EXISTS "Promotions insert" ON public.promotions;
DROP POLICY IF EXISTS "Promotions update" ON public.promotions;
DROP POLICY IF EXISTS "Promotions delete" ON public.promotions;

CREATE POLICY "Promotions select"
  ON public.promotions FOR SELECT
  TO authenticated
  USING ((SELECT public.has_active_access()));

CREATE POLICY "Promotions insert"
  ON public.promotions FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_lead_or_above()));

CREATE POLICY "Promotions update"
  ON public.promotions FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_lead_or_above()))
  WITH CHECK ((SELECT public.is_lead_or_above()));

CREATE POLICY "Promotions delete"
  ON public.promotions FOR DELETE
  TO authenticated
  USING ((SELECT public.is_supervisor_or_manager()));

-- O. Storage (internal-media) with InitPlan caching
DO $$
BEGIN
  DROP POLICY IF EXISTS "Internal media read active" ON storage.objects;
  DROP POLICY IF EXISTS "Internal media insert own folder" ON storage.objects;
  DROP POLICY IF EXISTS "Internal media update own or admin" ON storage.objects;
  DROP POLICY IF EXISTS "Internal media delete own or admin" ON storage.objects;

  CREATE POLICY "Internal media read active"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'internal-media' AND (SELECT public.has_active_access()));

  CREATE POLICY "Internal media insert own folder"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'internal-media'
      AND (SELECT public.has_active_access())
      AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
    );

  CREATE POLICY "Internal media update own or admin"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'internal-media'
      AND (
        ((SELECT public.has_active_access()) AND (storage.foldername(name))[1] = (SELECT auth.uid()::text))
        OR (SELECT public.is_supervisor_or_manager())
      )
    )
    WITH CHECK (
      bucket_id = 'internal-media'
      AND (
        ((SELECT public.has_active_access()) AND (storage.foldername(name))[1] = (SELECT auth.uid()::text))
        OR (SELECT public.is_supervisor_or_manager())
      )
    );

  CREATE POLICY "Internal media delete own or admin"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'internal-media'
      AND (
        ((SELECT public.has_active_access()) AND (storage.foldername(name))[1] = (SELECT auth.uid()::text))
        OR (SELECT public.is_supervisor_or_manager())
      )
    );
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping storage.objects policy updates due to privileges.';
END $$;

-- 7. Refresh query planner statistics & PostgREST schema cache
ANALYZE public.user_profiles;
ANALYZE public.user_access;
ANALYZE public.barcode_scans;
ANALYZE public.work_schedules;
ANALYZE public.activity_logs;
ANALYZE public.system_settings;
ANALYZE public.shift_definitions;
ANALYZE public.attendance_logs;
ANALYZE public.customer_feedbacks;
ANALYZE public.product_catalog;
ANALYZE public.supplier_policies;
ANALYZE public.expiry_tracking;
ANALYZE public.return_records;
ANALYZE public.promotions;

NOTIFY pgrst, 'reload schema';
