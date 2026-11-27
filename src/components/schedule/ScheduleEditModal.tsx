import { useEffect, useState } from 'react';
import { CheckCircle2, Radio, Trash2, X } from 'lucide-react';
import {
  SHIFT_META,
  SHIFT_ORDER,
  getShiftMeta,
} from '../../lib/scheduleMeta';
import type {
  OfficialWorkSchedule,
  ScheduleShiftCode,
  ScheduleStaffMember,
} from '../../types';

interface ScheduleEditModalProps {
  open: boolean;
  editingSchedule: OfficialWorkSchedule | null;
  presetStaffUid: string;
  presetDate: string;
  staffList: ScheduleStaffMember[];
  existingSchedules: OfficialWorkSchedule[];
  canDelete: boolean;
  onClose: () => void;
  onSave: (payload: {
    scheduleId?: string;
    staffUid: string;
    staffName: string;
    department: string;
    date: string;
    shiftType: ScheduleShiftCode;
    startTime: string;
    endTime: string;
    isTrucDam: boolean;
    note: string;
  }) => Promise<void>;
  onDelete?: (schedule: OfficialWorkSchedule) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function ScheduleEditModal({
  open,
  editingSchedule,
  presetStaffUid,
  presetDate,
  staffList,
  existingSchedules,
  canDelete,
  onClose,
  onSave,
  onDelete,
  onNotify,
}: ScheduleEditModalProps) {
  const [staffUid, setStaffUid] = useState('');
  const [customName, setCustomName] = useState('');
  const [customDept, setCustomDept] = useState('');
  const [date, setDate] = useState('');
  const [shiftType, setShiftType] = useState<ScheduleShiftCode>('ca_sang');
  const [startTime, setStartTime] = useState('07:00');
  const [endTime, setEndTime] = useState('15:00');
  const [isTrucDam, setIsTrucDam] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingSchedule) {
      setStaffUid(editingSchedule.staffUid);
      setCustomName(editingSchedule.staffName);
      setCustomDept(editingSchedule.department);
      setDate(editingSchedule.date);
      setShiftType(editingSchedule.shiftType);
      setStartTime(editingSchedule.startTime);
      setEndTime(editingSchedule.endTime);
      setIsTrucDam(editingSchedule.isTrucDam);
      setNote(editingSchedule.note);
    } else {
      const firstUid = presetStaffUid || staffList[0]?.uid || '__custom__';
      setStaffUid(firstUid);
      setCustomName('');
      setCustomDept('');
      setDate(presetDate);
      setShiftType('ca_sang');
      setStartTime(SHIFT_META.ca_sang.startTime);
      setEndTime(SHIFT_META.ca_sang.endTime);
      setIsTrucDam(false);
      setNote('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingSchedule, presetStaffUid, presetDate]);

  if (!open) return null;

  const meta = getShiftMeta(shiftType);

  const handleSelectShift = (code: ScheduleShiftCode) => {
    const m = getShiftMeta(code);
    setShiftType(code);
    setStartTime(m.startTime);
    setEndTime(m.endTime);
    if (m.isOffDay) {
      setIsTrucDam(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let finalUid = staffUid;
    let finalName = '';
    let finalDept = '';

    if (staffUid === '__custom__') {
      finalName = customName.trim();
      finalDept = customDept.trim() || 'Nhân viên';
      if (!finalName) {
        onNotify('error', 'Vui lòng nhập họ tên nhân sự.');
        return;
      }
      finalUid = `staff_${finalName
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '') || Date.now()}`;
    } else {
      const found = staffList.find((s) => s.uid === staffUid);
      finalName = found?.name || editingSchedule?.staffName || '';
      finalDept = found?.department || editingSchedule?.department || 'Nhân viên';
      if (!finalUid || !finalName) {
        onNotify('error', 'Vui lòng chọn nhân sự.');
        return;
      }
    }

    if (!date) {
      onNotify('error', 'Vui lòng chọn ngày làm việc.');
      return;
    }

    if (!meta.isOffDay && startTime >= endTime) {
      onNotify('error', 'Giờ kết thúc phải sau giờ bắt đầu.');
      return;
    }

    const duplicate = existingSchedules.some(
      (s) =>
        s.id !== editingSchedule?.id &&
        s.staffUid === finalUid &&
        s.date === date &&
        s.shiftType === shiftType
    );
    if (duplicate) {
      onNotify(
        'error',
        `${finalName} đã có "${meta.shortLabel}" trong ngày này rồi.`
      );
      return;
    }

    setSubmitting(true);
    try {
      await onSave({
        scheduleId: editingSchedule?.id,
        staffUid: finalUid,
        staffName: finalName,
        department: finalDept,
        date,
        shiftType,
        startTime: meta.isOffDay ? '00:00' : startTime,
        endTime: meta.isOffDay ? '00:00' : endTime,
        isTrucDam: meta.isOffDay ? false : isTrucDam,
        note: note.trim().slice(0, 300),
      });
      onClose();
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể lưu phân công ca.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!editingSchedule || !onDelete) return;
    setSubmitting(true);
    try {
      await onDelete(editingSchedule);
      onClose();
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể xóa ca làm việc.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-modal-title"
    >
      <div className="w-full sm:max-w-xl bg-white border border-slate-200 rounded-t-2xl sm:rounded-2xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 id="schedule-modal-title" className="text-base sm:text-lg font-bold text-slate-900">
            {editingSchedule ? 'Chỉnh sửa ca làm việc' : 'Phân công ca làm việc'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Nhân sự *
              </label>
              <select
                value={staffUid}
                onChange={(e) => setStaffUid(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {staffList.map((s) => (
                  <option key={s.uid} value={s.uid}>
                    {s.name} ({s.department || 'Nhân viên'})
                  </option>
                ))}
                {editingSchedule &&
                  !staffList.some((s) => s.uid === editingSchedule.staffUid) && (
                    <option value={editingSchedule.staffUid}>
                      {editingSchedule.staffName}
                    </option>
                  )}
                <option value="__custom__">+ Nhập nhân sự khác...</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Ngày áp dụng *
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {staffUid === '__custom__' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Họ và tên *
                </label>
                <input
                  type="text"
                  required
                  maxLength={120}
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="VD: Nguyễn Văn A"
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Chức vụ / Bộ phận
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={customDept}
                  onChange={(e) => setCustomDept(e.target.value)}
                  placeholder="VD: Bán hàng"
                  className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-300 rounded-lg bg-white"
                />
              </div>
            </div>
          )}

          {/* Quick shift preset buttons */}
          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">
              Chọn nhanh loại ca / ngày nghỉ *
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
              {SHIFT_ORDER.map((code) => {
                const m = SHIFT_META[code];
                const active = shiftType === code;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => handleSelectShift(code)}
                    className={`min-h-[38px] px-2 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                      active
                        ? `${m.cardBgClass} ${m.cardBorderClass} ${m.cardTextClass} ring-2 ring-blue-500`
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {m.shortLabel}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Đang chọn: <strong className="text-slate-800">{meta.label}</strong>
            </p>
          </div>

          {/* Custom time + Truc Dam */}
          {!meta.isOffDay && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Giờ bắt đầu
                </label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Giờ kết thúc
                </label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <label
                className={`min-h-[42px] px-3 py-2 rounded-lg border flex items-center gap-2 cursor-pointer select-none transition-colors ${
                  isTrucDam
                    ? 'bg-orange-50 border-orange-300 text-orange-800'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isTrucDam}
                  onChange={(e) => setIsTrucDam(e.target.checked)}
                  className="h-4 w-4 accent-orange-600"
                />
                <Radio className="h-4 w-4 text-orange-600 shrink-0" />
                <span className="text-xs font-semibold">Trực đàm (TĐ)</span>
              </label>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-700">
                Ghi chú ca
              </label>
              <span className="text-[11px] text-slate-400 tabular-nums">
                {note.length}/300
              </span>
            </div>
            <textarea
              rows={2}
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="VD: Hỗ trợ kiểm kê cuối ngày..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            {editingSchedule && canDelete && onDelete ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleDelete()}
                className="min-h-[42px] px-3.5 py-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm font-medium hover:bg-red-100 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Trash2 className="h-4 w-4" />
                <span>Xóa ca này</span>
              </button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[42px] px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  {submitting
                    ? 'Đang lưu...'
                    : editingSchedule
                      ? 'Cập nhật ca'
                      : 'Lưu phân công'}
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
