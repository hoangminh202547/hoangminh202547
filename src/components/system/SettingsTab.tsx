import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Save, SlidersHorizontal } from 'lucide-react';
import { saveLeaveRules } from '../../lib/supabaseOps';
import type { LeaveRulesConfig, UiPreferences } from '../../types';

interface SettingsTabProps {
  client: SupabaseClient | null;
  actorEmail: string;
  isStoreManager: boolean;
  leaveRules: LeaveRulesConfig;
  uiPrefs: UiPreferences;
  onUpdateLeaveRules: (rules: LeaveRulesConfig) => void;
  onUpdateUiPrefs: (prefs: UiPreferences) => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function SettingsTab({
  client,
  actorEmail,
  isStoreManager,
  leaveRules,
  uiPrefs,
  onUpdateLeaveRules,
  onUpdateUiPrefs,
  onNotify,
}: SettingsTabProps) {
  const [rulesForm, setRulesForm] = useState<LeaveRulesConfig>(leaveRules);
  const [savingRules, setSavingRules] = useState(false);

  const handleSaveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || !isStoreManager) return;
    setSavingRules(true);
    const res = await saveLeaveRules(client, rulesForm, actorEmail);
    setSavingRules(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onUpdateLeaveRules(rulesForm);
    onNotify('success', 'Đã cập nhật quy định ngày nghỉ tuần (DO) lên Supabase.');
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* UI Preferences */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-slate-900 font-bold">
          <SlidersHorizontal className="h-5 w-5 text-blue-600" />
          <h3>Tùy chọn hiển thị &amp; tối ưu tải dữ liệu</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Số dòng mặc định mỗi trang bảng
            </label>
            <select
              value={uiPrefs.defaultPageSize}
              onChange={(e) =>
                onUpdateUiPrefs({
                  ...uiPrefs,
                  defaultPageSize: Number(e.target.value) as 20 | 50 | 100,
                })
              }
              className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value={20}>20 dòng (Khuyên dùng - tiết kiệm egress)</option>
              <option value={50}>50 dòng</option>
              <option value={100}>100 dòng</option>
            </select>
          </div>

          <div className="flex flex-col justify-center gap-2 pt-2">
            <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={uiPrefs.compactSidebar}
                onChange={(e) =>
                  onUpdateUiPrefs({ ...uiPrefs, compactSidebar: e.target.checked })
                }
                className="h-4 w-4 rounded border-slate-300"
              />
              <span>Thu gọn thanh menu bên trên màn hình lớn</span>
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={uiPrefs.autoResetPromoIdle}
                onChange={(e) =>
                  onUpdateUiPrefs({ ...uiPrefs, autoResetPromoIdle: e.target.checked })
                }
                className="h-4 w-4 rounded border-slate-300"
              />
              <span>Tự đặt lại bộ lọc Khuyến mãi sau 60s không thao tác</span>
            </label>
          </div>
        </div>
      </div>

      {/* Leave / DO Rules */}
      <form
        onSubmit={handleSaveRules}
        className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
      >
        <div>
          <h3 className="text-base font-bold text-slate-900">
            Quy định ngày nghỉ tuần (DO)
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Quy định được đồng bộ và kiểm tra trực tiếp bởi PostgreSQL Trigger trên bảng <span className="font-mono">work_schedules</span>.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Tối đa DO / người / tuần (T2–CN)
            </label>
            <input
              type="number"
              min={0}
              max={7}
              disabled={!isStoreManager}
              value={rulesForm.maxDoPerWeek}
              onChange={(e) =>
                setRulesForm((p) => ({ ...p, maxDoPerWeek: Number(e.target.value) }))
              }
              className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Tối đa nhân sự nghỉ DO / ngày (T2–T6)
            </label>
            <input
              type="number"
              min={0}
              max={20}
              disabled={!isStoreManager}
              value={rulesForm.weekdayMaxDo}
              onChange={(e) =>
                setRulesForm((p) => ({ ...p, weekdayMaxDo: Number(e.target.value) }))
              }
              className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Tối đa nhân sự nghỉ DO / ngày (T7–CN)
            </label>
            <input
              type="number"
              min={0}
              max={20}
              disabled={!isStoreManager}
              value={rulesForm.weekendMaxDo}
              onChange={(e) =>
                setRulesForm((p) => ({ ...p, weekendMaxDo: Number(e.target.value) }))
              }
              className="w-full min-h-[40px] px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg disabled:bg-slate-100"
            />
          </div>
        </div>

        {isStoreManager ? (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingRules || !client}
              className="min-h-[40px] px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              <Save className="h-4 w-4" />
              <span>{savingRules ? 'Đang lưu...' : 'Lưu quy định DO'}</span>
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Chỉ tài khoản Quản trị mới có quyền chỉnh sửa định mức ngày nghỉ DO.
          </p>
        )}
      </form>
    </div>
  );
}
