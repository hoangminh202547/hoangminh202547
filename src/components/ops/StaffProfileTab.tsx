import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Camera, Phone, Save, Search, UserCircle, Users } from 'lucide-react';
import { compressImageToWebP } from '../../lib/media';
import { ROLE_LABELS } from '../../lib/permissions';
import {
  fetchUserProfiles,
  updateMyProfileDetails,
  uploadMediaPairToStorage,
  useScopedRealtime,
} from '../../lib/supabaseOps';
import type {
  AuthenticatedUser,
  AuthorizedEmail,
  UserProfileRecord,
} from '../../types';
import { SignedMediaThumb } from '../SignedMediaThumb';

interface StaffProfileTabProps {
  client: SupabaseClient | null;
  user: AuthenticatedUser;
  members: AuthorizedEmail[];
  onProfileUpdated: (newName: string) => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

export function StaffProfileTab({
  client,
  user,
  members,
  onProfileUpdated,
  onNotify,
}: StaffProfileTabProps) {
  const [subTab, setSubTab] = useState<'profile' | 'directory'>('profile');
  const [profiles, setProfiles] = useState<UserProfileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Editable personal profile form
  const [displayName, setDisplayName] = useState(user.displayName);
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [phone, setPhone] = useState('');
  const [avatarPath, setAvatarPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const loadProfiles = useCallback(async (forceRefresh = false) => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const list = await fetchUserProfiles(client, forceRefresh);
    setProfiles(list);
    const mine = list.find(
      (p) => p.id === user.uid || p.email.toLowerCase() === user.email.toLowerCase()
    );
    if (mine) {
      setDisplayName(mine.displayName || user.displayName);
      setBirthDate(mine.birthDate || '');
      setGender(mine.gender || '');
      setPhone(mine.phone || '');
      setAvatarPath(mine.avatarPath || '');
    }
    setLoading(false);
  }, [client, user.uid, user.email, user.displayName]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useScopedRealtime(
    client,
    Boolean(client),
    ['user_profiles'],
    () => {
      void loadProfiles(true);
    }
  );

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !client) return;

    setUploadingAvatar(true);
    try {
      const compressed = await compressImageToWebP(file, {
        maxDim: 512,
        thumbDim: 160,
        quality: 0.78,
      });
      const uploaded = await uploadMediaPairToStorage(
        client,
        user.uid,
        'avatars',
        compressed.mainBlob
      );
      if (uploaded.error) {
        onNotify('error', `Lỗi tải ảnh đại diện: ${uploaded.error}`);
        return;
      }
      setAvatarPath(uploaded.path);
      const saveRes = await updateMyProfileDetails(client, user.uid, user.email, {
        displayName,
        birthDate,
        gender,
        phone,
        avatarPath: uploaded.path,
      });
      if (saveRes.error) {
        onNotify('error', saveRes.error);
      } else {
        onNotify('success', 'Đã nén WebP và cập nhật ảnh đại diện.');
        void loadProfiles(true);
      }
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể nén ảnh đại diện.'
      );
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) {
      onNotify('error', 'Cần kết nối Supabase Auth để lưu hồ sơ.');
      return;
    }
    if (!displayName.trim()) {
      onNotify('error', 'Vui lòng nhập họ và tên.');
      return;
    }
    setSaving(true);
    const res = await updateMyProfileDetails(client, user.uid, user.email, {
      displayName: displayName.trim(),
      birthDate,
      gender,
      phone,
    });
    setSaving(false);
    if (res.error) {
      onNotify('error', res.error);
      return;
    }
    onProfileUpdated(displayName.trim());
    onNotify('success', 'Đã lưu hồ sơ nhân sự cá nhân.');
    void loadProfiles(true);
  };

  const directoryRows = useMemo(() => {
    const profileMap = new Map<string, UserProfileRecord>();
    for (const p of profiles) {
      profileMap.set(p.email.toLowerCase(), p);
    }
    const merged = new Map<
      string,
      {
        email: string;
        displayName: string;
        roleLabel: string;
        active: boolean;
        phone: string;
        gender: string;
        birthDate: string;
        avatarPath: string;
        avatarUrl: string;
      }
    >();

    for (const m of members) {
      const p = profileMap.get(m.email.toLowerCase());
      merged.set(m.email.toLowerCase(), {
        email: m.email,
        displayName: p?.displayName || m.displayName || m.email,
        roleLabel: ROLE_LABELS[m.role] || m.role,
        active: m.active,
        phone: p?.phone || '',
        gender: p?.gender || '',
        birthDate: p?.birthDate || '',
        avatarPath: p?.avatarPath || '',
        avatarUrl: p?.avatarUrl || '',
      });
    }

    for (const p of profiles) {
      if (!merged.has(p.email.toLowerCase())) {
        merged.set(p.email.toLowerCase(), {
          email: p.email,
          displayName: p.displayName || p.email,
          roleLabel: 'Nhân sự',
          active: true,
          phone: p.phone,
          gender: p.gender,
          birthDate: p.birthDate,
          avatarPath: p.avatarPath,
          avatarUrl: p.avatarUrl,
        });
      }
    }

    const q = search.trim().toLowerCase();
    return Array.from(merged.values()).filter(
      (r) =>
        !q ||
        r.displayName.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.phone.toLowerCase().includes(q)
    );
  }, [profiles, members, search]);

  return (
    <div className="space-y-6">
      {/* Sub-navigation */}
      <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200">
        <button
          type="button"
          onClick={() => setSubTab('profile')}
          className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-md inline-flex items-center gap-2 ${
            subTab === 'profile' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          <UserCircle className="h-4 w-4" />
          <span>Hồ sơ cá nhân</span>
        </button>
        <button
          type="button"
          onClick={() => setSubTab('directory')}
          className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-md inline-flex items-center gap-2 ${
            subTab === 'directory' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
          }`}
        >
          <Users className="h-4 w-4" />
          <span>Danh sách nhân sự ({directoryRows.length})</span>
        </button>
      </div>

      {subTab === 'profile' ? (
        <form
          onSubmit={handleSaveProfile}
          className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-5"
        >
          <div className="flex items-center gap-4">
            {avatarPath ? (
              <SignedMediaThumb
                client={client}
                thumbPath={avatarPath}
                alt={displayName}
                className="h-16 w-16 rounded-full object-cover border border-slate-200"
              />
            ) : (
              <div className="h-16 w-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200">
                <UserCircle className="h-9 w-9" />
              </div>
            )}

            <div>
              <h3 className="text-base font-bold text-slate-900">{displayName || user.displayName}</h3>
              <p className="text-xs font-mono text-slate-500">{user.email}</p>
              <label className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer">
                <Camera className="h-3.5 w-3.5 text-blue-600" />
                <span>{uploadingAvatar ? 'Đang nén & tải...' : 'Cập nhật ảnh đại diện'}</span>
                <input
                  type="file"
                  accept="image/*"
                  disabled={uploadingAvatar || !client}
                  onChange={handleAvatarUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Họ và tên *</label>
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Email đăng nhập (chỉ đọc)</label>
              <input
                type="email"
                readOnly
                value={user.email}
                className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-slate-100 text-slate-600 border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Ngày sinh</label>
              <input
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Giới tính</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Chưa chọn</option>
                <option value="Nam">Nam</option>
                <option value="Nữ">Nữ</option>
                <option value="Khác">Khác</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Số điện thoại liên hệ</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="09xx xxx xxx"
                className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving || !client}
              className="min-h-[42px] px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? 'Đang lưu...' : 'Lưu thông tin cá nhân'}</span>
            </button>
          </div>
        </form>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="relative max-w-sm w-full">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm tên, email, số điện thoại..."
                className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {loading ? (
            <div className="p-6 text-sm text-slate-500">Đang tải danh sách nhân sự...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
              {directoryRows.map((person) => (
                <div
                  key={person.email}
                  className="border border-slate-200 rounded-xl p-4 flex items-start gap-3"
                >
                  {person.avatarPath ? (
                    <SignedMediaThumb
                      client={client}
                      thumbPath={person.avatarPath}
                      alt={person.displayName}
                      className="h-11 w-11 rounded-full object-cover border border-slate-200 shrink-0"
                    />
                  ) : (
                    <div className="h-11 w-11 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                      <UserCircle className="h-6 w-6" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold text-sm text-slate-900 truncate">{person.displayName}</p>
                      <span
                        className={`text-[11px] font-medium ${
                          person.active ? 'text-emerald-700' : 'text-slate-400'
                        }`}
                      >
                        {person.active ? 'Hoạt động' : 'Tạm khóa'}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-blue-700">{person.roleLabel}</p>
                    <p className="text-xs font-mono text-slate-500 truncate mt-0.5">{person.email}</p>
                    {person.phone && (
                      <p className="mt-1 text-xs text-slate-600 inline-flex items-center gap-1 font-mono">
                        <Phone className="h-3 w-3 text-slate-400" />
                        <span>{person.phone}</span>
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
