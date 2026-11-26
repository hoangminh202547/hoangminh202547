-- ============================================================================
-- Migration 002: Vận Hành TPCN Full Operations, Goods & Storage Schema
-- Additive-only migration: Safe to execute on top of existing schema.sql
-- Preserves all existing data & keeps RLS strictly enabled.
-- ============================================================================

-- 1. Extend existing user_profiles (additive columns)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS birth_date TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS avatar_path TEXT NOT NULL DEFAULT '';

-- Allow active team members to view staff directory (id, display_name, email, avatar, phone)
DROP POLICY IF EXISTS "Profiles read own or manager" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles read active team" ON public.user_profiles;
CREATE POLICY "Profiles read active team"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR LOWER(email) = public.current_user_email()
    OR public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
    )
  );

-- 2. Extend user_access with granular JSONB module permissions
ALTER TABLE public.user_access
  ADD COLUMN IF NOT EXISTS module_perms JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 3. Extend activity_logs module constraint for all new operational areas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'activity_logs'
      AND constraint_name = 'activity_logs_module_check'
  ) THEN
    ALTER TABLE public.activity_logs DROP CONSTRAINT activity_logs_module_check;
  END IF;
END
$$;

ALTER TABLE public.activity_logs
  ADD CONSTRAINT activity_logs_module_check
  CHECK (module IN (
    'barcode', 'schedule', 'attendance', 'staff', 'feedback',
    'warehouse', 'expiry', 'returns', 'promotions', 'storage',
    'access', 'system', 'export'
  ));

-- 4. Helper functions for role checks
CREATE OR REPLACE FUNCTION public.has_active_access()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
    );
$$;

CREATE OR REPLACE FUNCTION public.is_supervisor_or_manager()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.role IN ('store_manager', 'supervisor')
    );
$$;

CREATE OR REPLACE FUNCTION public.is_lead_or_above()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.role IN ('store_manager', 'supervisor', 'shift_lead')
    );
$$;

-- 5. System Settings (Admin configurable rules, incl. Leave/DO limits)
CREATE TABLE IF NOT EXISTS public.system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_settings (key, value, updated_by)
VALUES (
  'leave_rules',
  '{"max_do_per_week": 2, "weekday_max_do": 2, "weekend_max_do": 1, "require_admin_override": true}'::jsonb,
  'system'
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Settings read active" ON public.system_settings;
DROP POLICY IF EXISTS "Settings write manager" ON public.system_settings;

CREATE POLICY "Settings read active"
  ON public.system_settings FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Settings write manager"
  ON public.system_settings FOR ALL
  TO authenticated
  USING (public.is_store_manager())
  WITH CHECK (public.is_store_manager());

-- 6. Shift Definitions (Thiết lập ca làm việc)
CREATE TABLE IF NOT EXISTS public.shift_definitions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_day_off BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.validate_shift_definition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.code := UPPER(TRIM(NEW.code));
  NEW.name := TRIM(NEW.name);
  IF NOT NEW.is_day_off AND NEW.start_time >= NEW.end_time THEN
    RAISE EXCEPTION 'Giờ bắt đầu ca (%) phải nhỏ hơn giờ kết thúc (%).', NEW.start_time, NEW.end_time;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shift_definition_validate ON public.shift_definitions;
CREATE TRIGGER trg_shift_definition_validate
  BEFORE INSERT OR UPDATE ON public.shift_definitions
  FOR EACH ROW EXECUTE FUNCTION public.validate_shift_definition();

INSERT INTO public.shift_definitions (id, code, name, start_time, end_time, is_day_off, sort_order, active)
VALUES
  ('shift-morning', 'CA_SANG', 'Ca sáng', '08:00', '12:00', false, 1, true),
  ('shift-afternoon', 'CA_CHIEU', 'Ca chiều', '13:30', '17:30', false, 2, true),
  ('shift-evening', 'CA_TOI', 'Ca tối', '18:00', '22:00', false, 3, true),
  ('shift-fullday', 'CA_NGAY', 'Cả ngày', '08:00', '17:30', false, 4, true),
  ('shift-do', 'DO', 'Nghỉ tuần (DO)', '00:00', '00:00', true, 5, true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.shift_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Shifts read active" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts write manager" ON public.shift_definitions;

CREATE POLICY "Shifts read active"
  ON public.shift_definitions FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Shifts write manager"
  ON public.shift_definitions FOR ALL
  TO authenticated
  USING (public.is_store_manager() OR public.is_supervisor_or_manager())
  WITH CHECK (public.is_store_manager() OR public.is_supervisor_or_manager());

-- 7. Extend work_schedules + Enforce DO rules trigger
ALTER TABLE public.work_schedules
  ADD COLUMN IF NOT EXISTS shift_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_day_off BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_approved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.enforce_work_schedule_do_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rules JSONB;
  v_max_week INT := 2;
  v_weekday_max INT := 2;
  v_weekend_max INT := 1;
  v_work_dt DATE;
  v_week_start DATE;
  v_week_end DATE;
  v_dow INT;
  v_user_week_do INT := 0;
  v_day_do INT := 0;
  v_day_limit INT;
BEGIN
  IF NOT COALESCE(NEW.is_day_off, false) OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Only Admin / Store Manager can set override_approved = true
  IF COALESCE(NEW.override_approved, false) AND NOT public.is_store_manager() THEN
    RAISE EXCEPTION 'Chỉ Quản trị mới có quyền phê duyệt vượt giới hạn ngày nghỉ DO.';
  END IF;

  IF COALESCE(NEW.override_approved, false) THEN
    RETURN NEW;
  END IF;

  SELECT value INTO v_rules FROM public.system_settings WHERE key = 'leave_rules' LIMIT 1;
  IF v_rules IS NOT NULL THEN
    v_max_week := COALESCE((v_rules->>'max_do_per_week')::int, 2);
    v_weekday_max := COALESCE((v_rules->>'weekday_max_do')::int, 2);
    v_weekend_max := COALESCE((v_rules->>'weekend_max_do')::int, 1);
  END IF;

  v_work_dt := TO_DATE(NEW.work_date, 'YYYY-MM-DD');
  -- Monday-start week (ISODOW: 1=Mon .. 7=Sun)
  v_dow := EXTRACT(ISODOW FROM v_work_dt)::int;
  v_week_start := v_work_dt - (v_dow - 1);
  v_week_end := v_week_start + 6;

  SELECT COUNT(*) INTO v_user_week_do
  FROM public.work_schedules ws
  WHERE LOWER(ws.owner_email) = LOWER(NEW.owner_email)
    AND COALESCE(ws.is_day_off, false) = true
    AND ws.status <> 'cancelled'
    AND ws.id <> NEW.id
    AND ws.work_date >= TO_CHAR(v_week_start, 'YYYY-MM-DD')
    AND ws.work_date <= TO_CHAR(v_week_end, 'YYYY-MM-DD');

  IF v_user_week_do >= v_max_week THEN
    RAISE EXCEPTION 'Mỗi nhân viên tối đa % ngày nghỉ DO trong 1 tuần (Thứ 2 - Chủ nhật). Cần Quản trị duyệt nếu ngoại lệ.', v_max_week;
  END IF;

  v_day_limit := CASE WHEN v_dow IN (6, 7) THEN v_weekend_max ELSE v_weekday_max END;

  SELECT COUNT(*) INTO v_day_do
  FROM public.work_schedules ws
  WHERE ws.work_date = NEW.work_date
    AND COALESCE(ws.is_day_off, false) = true
    AND ws.status <> 'cancelled'
    AND ws.id <> NEW.id;

  IF v_day_do >= v_day_limit THEN
    RAISE EXCEPTION 'Ngày % đã đủ tối đa % người nghỉ DO. Cần Quản trị phê duyệt nếu có ngoại lệ.', NEW.work_date, v_day_limit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_schedule_do_rules ON public.work_schedules;
CREATE TRIGGER trg_work_schedule_do_rules
  BEFORE INSERT OR UPDATE ON public.work_schedules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_work_schedule_do_rules();

-- 8. Attendance Logs (Chấm công — Server time enforced + append-only notes history)
CREATE TABLE IF NOT EXISTS public.attendance_logs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NULL,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  shift_name TEXT NOT NULL DEFAULT '',
  work_date TEXT NOT NULL,
  check_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  check_out_at TIMESTAMPTZ NULL,
  is_unscheduled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'checked_in'
    CHECK (status IN ('checked_in', 'checked_out', 'early_leave', 'overtime')),
  notes_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_work_date ON public.attendance_logs (work_date DESC, check_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_owner_email ON public.attendance_logs (owner_email, work_date DESC);

CREATE OR REPLACE FUNCTION public.enforce_attendance_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_dup_count INT := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Force server timestamp so client cannot tamper check-in time
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

  -- On UPDATE: preserve check_in_at and disallow deleting/mutating previous notes_history entries
  NEW.check_in_at := OLD.check_in_at;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := NOW();

  IF jsonb_typeof(OLD.notes_history) = 'array' AND jsonb_typeof(NEW.notes_history) = 'array' THEN
    IF jsonb_array_length(NEW.notes_history) < jsonb_array_length(OLD.notes_history) THEN
      RAISE EXCEPTION 'Không được xóa lịch sử ghi chú chấm công trước đó.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_integrity ON public.attendance_logs;
CREATE TRIGGER trg_attendance_integrity
  BEFORE INSERT OR UPDATE ON public.attendance_logs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_attendance_integrity();

ALTER TABLE public.attendance_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Attendance select" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance insert" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance update" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance delete" ON public.attendance_logs;

CREATE POLICY "Attendance select"
  ON public.attendance_logs FOR SELECT
  TO authenticated
  USING (
    public.is_lead_or_above()
    OR LOWER(owner_email) = public.current_user_email()
    OR owner_id = auth.uid()::text
  );

CREATE POLICY "Attendance insert"
  ON public.attendance_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_active_access()
    AND (LOWER(owner_email) = public.current_user_email() OR public.is_store_manager())
  );

CREATE POLICY "Attendance update"
  ON public.attendance_logs FOR UPDATE
  TO authenticated
  USING (
    public.is_lead_or_above()
    OR LOWER(owner_email) = public.current_user_email()
  )
  WITH CHECK (
    public.is_lead_or_above()
    OR LOWER(owner_email) = public.current_user_email()
  );

CREATE POLICY "Attendance delete"
  ON public.attendance_logs FOR DELETE
  TO authenticated
  USING (public.is_store_manager());

-- 9. Customer Feedbacks (Ý kiến khách hàng — Server timestamp enforced)
CREATE TABLE IF NOT EXISTS public.customer_feedbacks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  feedback_date TEXT NOT NULL DEFAULT TO_CHAR(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD'),
  category TEXT NOT NULL CHECK (category IN ('product', 'service')),
  product_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  image_path TEXT NOT NULL DEFAULT '',
  image_thumb_path TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_date_created ON public.customer_feedbacks (feedback_date DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_feedback_owner_date ON public.customer_feedbacks (owner_email, feedback_date);

CREATE OR REPLACE FUNCTION public.enforce_feedback_server_time()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    NEW.feedback_date := TO_CHAR(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD');
    NEW.owner_email := LOWER(TRIM(NEW.owner_email));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feedback_server_time ON public.customer_feedbacks;
CREATE TRIGGER trg_feedback_server_time
  BEFORE INSERT ON public.customer_feedbacks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_feedback_server_time();

ALTER TABLE public.customer_feedbacks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Feedback select" ON public.customer_feedbacks;
DROP POLICY IF EXISTS "Feedback insert" ON public.customer_feedbacks;
DROP POLICY IF EXISTS "Feedback delete" ON public.customer_feedbacks;

CREATE POLICY "Feedback select"
  ON public.customer_feedbacks FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Feedback insert"
  ON public.customer_feedbacks FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_active_access()
    AND (LOWER(owner_email) = public.current_user_email() OR public.is_store_manager())
  );

CREATE POLICY "Feedback delete"
  ON public.customer_feedbacks FOR DELETE
  TO authenticated
  USING (
    public.is_supervisor_or_manager()
    OR LOWER(owner_email) = public.current_user_email()
  );

-- 10. Product Catalog (Kho dữ liệu - Danh mục hàng)
CREATE TABLE IF NOT EXISTS public.product_catalog (
  id TEXT PRIMARY KEY,
  product_code TEXT UNIQUE NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  supplier_name TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_barcode ON public.product_catalog (barcode);
CREATE INDEX IF NOT EXISTS idx_catalog_supplier ON public.product_catalog (supplier_name);
CREATE INDEX IF NOT EXISTS idx_catalog_name ON public.product_catalog (name);

ALTER TABLE public.product_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Catalog select" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog write" ON public.product_catalog;

CREATE POLICY "Catalog select"
  ON public.product_catalog FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Catalog write"
  ON public.product_catalog FOR ALL
  TO authenticated
  USING (public.is_lead_or_above())
  WITH CHECK (public.is_lead_or_above());

-- 11. Supplier Return Policies (Kho dữ liệu - Chính sách đổi trả NCC)
CREATE TABLE IF NOT EXISTS public.supplier_policies (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL DEFAULT '',
  supplier_system_name TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  return_policy TEXT NOT NULL DEFAULT '',
  warn_months_before INTEGER NOT NULL DEFAULT 0 CHECK (warn_months_before >= 0 AND warn_months_before <= 36),
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_policy_unique
  ON public.supplier_policies (LOWER(supplier_system_name), LOWER(product_name));

ALTER TABLE public.supplier_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Policies select" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies write" ON public.supplier_policies;

CREATE POLICY "Policies select"
  ON public.supplier_policies FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Policies write"
  ON public.supplier_policies FOR ALL
  TO authenticated
  USING (public.is_lead_or_above())
  WITH CHECK (public.is_lead_or_above());

-- 12. Expiry Tracking (Kiểm soát hạn sử dụng)
CREATE TABLE IF NOT EXISTS public.expiry_tracking (
  id TEXT PRIMARY KEY,
  product_code TEXT NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  supplier_system_name TEXT NOT NULL DEFAULT '',
  return_policy TEXT NOT NULL DEFAULT '',
  warn_months_before INTEGER NOT NULL DEFAULT 0,
  mfg_date TEXT NOT NULL DEFAULT '',
  exp_date TEXT NOT NULL,
  pt_code TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expiry_exp_date ON public.expiry_tracking (exp_date ASC);
CREATE INDEX IF NOT EXISTS idx_expiry_pt_code ON public.expiry_tracking (pt_code);
CREATE INDEX IF NOT EXISTS idx_expiry_product_code ON public.expiry_tracking (product_code);

ALTER TABLE public.expiry_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Expiry select" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry insert" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry update" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry delete" ON public.expiry_tracking;

CREATE POLICY "Expiry select"
  ON public.expiry_tracking FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Expiry insert"
  ON public.expiry_tracking FOR INSERT
  TO authenticated
  WITH CHECK (public.has_active_access());

CREATE POLICY "Expiry update"
  ON public.expiry_tracking FOR UPDATE
  TO authenticated
  USING (public.has_active_access())
  WITH CHECK (public.has_active_access());

CREATE POLICY "Expiry delete"
  ON public.expiry_tracking FOR DELETE
  TO authenticated
  USING (public.is_lead_or_above());

-- 13. Goods Return Records (Đổi trả hàng hóa)
CREATE TABLE IF NOT EXISTS public.return_records (
  id TEXT PRIMARY KEY,
  pt_code TEXT NOT NULL DEFAULT '',
  supplier_system_name TEXT NOT NULL,
  product_summary TEXT NOT NULL,
  return_method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT 'processing'
    CHECK (progress IN ('processing', 'completed')),
  reported_date TEXT NOT NULL DEFAULT '',
  completed_date TEXT NOT NULL DEFAULT '',
  last_update_note TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_returns_progress ON public.return_records (progress, updated_at DESC);

ALTER TABLE public.return_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Returns select" ON public.return_records;
DROP POLICY IF EXISTS "Returns insert" ON public.return_records;
DROP POLICY IF EXISTS "Returns update" ON public.return_records;
DROP POLICY IF EXISTS "Returns delete" ON public.return_records;

CREATE POLICY "Returns select"
  ON public.return_records FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Returns insert"
  ON public.return_records FOR INSERT
  TO authenticated
  WITH CHECK (public.has_active_access());

CREATE POLICY "Returns update"
  ON public.return_records FOR UPDATE
  TO authenticated
  USING (public.has_active_access())
  WITH CHECK (public.has_active_access());

CREATE POLICY "Returns delete"
  ON public.return_records FOR DELETE
  TO authenticated
  USING (public.is_lead_or_above());

-- 14. Promotions (Chương trình khuyến mãi)
CREATE TABLE IF NOT EXISTS public.promotions (
  id TEXT PRIMARY KEY,
  product_code TEXT NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL,
  has_b_badge BOOLEAN NOT NULL DEFAULT false,
  unit TEXT NOT NULL DEFAULT '',
  exp_date TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  discount_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_rate >= 0 AND discount_rate <= 100),
  regular_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (regular_price >= 0),
  promo_price NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(regular_price * (1 - discount_rate / 100.0), 0)) STORED,
  pt_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'scheduled', 'ended')),
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_unique_combo
  ON public.promotions (product_code, exp_date, discount_rate);
CREATE INDEX IF NOT EXISTS idx_promotions_exp_date ON public.promotions (exp_date ASC);

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Promotions select" ON public.promotions;
DROP POLICY IF EXISTS "Promotions insert" ON public.promotions;
DROP POLICY IF EXISTS "Promotions update" ON public.promotions;
DROP POLICY IF EXISTS "Promotions delete" ON public.promotions;

CREATE POLICY "Promotions select"
  ON public.promotions FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Promotions insert"
  ON public.promotions FOR INSERT
  TO authenticated
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Promotions update"
  ON public.promotions FOR UPDATE
  TO authenticated
  USING (public.is_lead_or_above())
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Promotions delete"
  ON public.promotions FOR DELETE
  TO authenticated
  USING (public.is_supervisor_or_manager());

-- 15. Private Storage Bucket for internal media (avatars & customer feedback photos)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'internal-media',
  'internal-media',
  false,
  5242880,
  ARRAY['image/webp', 'image/jpeg', 'image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Internal media read active" ON storage.objects;
DROP POLICY IF EXISTS "Internal media insert own folder" ON storage.objects;
DROP POLICY IF EXISTS "Internal media delete own or admin" ON storage.objects;

CREATE POLICY "Internal media read active"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'internal-media' AND public.has_active_access());

CREATE POLICY "Internal media insert own folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'internal-media'
    AND public.has_active_access()
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Internal media delete own or admin"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'internal-media'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_supervisor_or_manager()
    )
  );

-- 16. Enable Realtime on new operational tables
ALTER TABLE public.attendance_logs REPLICA IDENTITY FULL;
ALTER TABLE public.customer_feedbacks REPLICA IDENTITY FULL;
ALTER TABLE public.expiry_tracking REPLICA IDENTITY FULL;
ALTER TABLE public.return_records REPLICA IDENTITY FULL;
ALTER TABLE public.promotions REPLICA IDENTITY FULL;
ALTER TABLE public.shift_definitions REPLICA IDENTITY FULL;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'attendance_logs',
    'customer_feedbacks',
    'expiry_tracking',
    'return_records',
    'promotions',
    'shift_definitions'
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
