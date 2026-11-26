import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { KeyRound, ScanBarcode } from 'lucide-react';
import { signInWithGmail as signInWithFirebaseGmail } from '../lib/firebase';
import {
  fetchSupabaseAuthSettings,
  formatSupabaseAuthError,
  getSupabaseClient,
  isValidSupabaseConfig,
  signInWithSupabaseGooglePopup,
} from '../lib/supabase';
import type { SupabaseConfig } from '../types';

interface SignInScreenProps {
  supabaseConfig: SupabaseConfig;
  onSupabaseSessionReady?: (session?: Session | null) => void;
}

export function SignInScreen({
  supabaseConfig,
  onSupabaseSessionReady,
}: SignInScreenProps) {
  const supabaseAvailable = isValidSupabaseConfig(supabaseConfig);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      if (supabaseAvailable) {
        const settings = await fetchSupabaseAuthSettings(supabaseConfig);
        if (settings.ok && !settings.googleEnabled) {
          await signInWithFirebaseGmail();
          return;
        }
        const client = getSupabaseClient(supabaseConfig);
        if (!client) throw new Error('Không thể khởi tạo kết nối Supabase.');
        const session = await signInWithSupabaseGooglePopup(client);
        onSupabaseSessionReady?.(session);
      } else {
        await signInWithFirebaseGmail();
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('popup-closed-by-user')) {
        setError('Cửa sổ đăng nhập Gmail đã bị đóng trước khi hoàn tất.');
      } else if (raw.includes('popup-blocked')) {
        setError('Trình duyệt đã chặn cửa sổ bật lên. Vui lòng cho phép popup để đăng nhập.');
      } else {
        setError(formatSupabaseAuthError(err));
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabaseAvailable) return;
    const client = getSupabaseClient(supabaseConfig);
    if (!client) return;

    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const callbackUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}/auth/callback`
          : undefined;
      if (isSignUp) {
        const { data, error: signUpErr } = await client.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            emailRedirectTo: callbackUrl,
            data: {
              full_name: displayName.trim() || email.split('@')[0],
            },
          },
        });
        if (signUpErr) throw signUpErr;
        if (data.session) {
          onSupabaseSessionReady?.(data.session);
        } else {
          setInfo('Đã tạo tài khoản. Vui lòng xác nhận qua Gmail để đăng nhập.');
        }
      } else {
        const { data, error: signInErr } =
          await client.auth.signInWithPassword({
            email: email.trim().toLowerCase(),
            password,
          });
        if (signInErr) throw signInErr;
        onSupabaseSessionReady?.(data.session);
      }
    } catch (err) {
      setError(formatSupabaseAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 text-center space-y-6">
        {/* Minimal Brand Mark + App Name */}
        <div className="flex flex-col items-center gap-3">
          <div className="h-14 w-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-xs">
            <ScanBarcode className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">
              Vận Hành TPCN
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Hệ thống quản lý vận hành, hàng hóa &amp; dữ liệu nội bộ
            </p>
          </div>
        </div>

        {/* Google Login Primary Gate */}
        <div className="space-y-3">
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="gsi-material-button w-full"
          >
            <svg
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 48 48"
              className="h-5 w-5 shrink-0"
              aria-hidden="true"
            >
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            <span>{loading ? 'Đang đăng nhập...' : 'Đăng nhập bằng Google'}</span>
          </button>

          {supabaseAvailable && (
            <button
              type="button"
              onClick={() => {
                setShowEmailForm((v) => !v);
                setError(null);
                setInfo(null);
              }}
              className="text-xs text-slate-500 hover:text-slate-800 py-1"
            >
              {showEmailForm ? 'Ẩn đăng nhập Email' : 'Đăng nhập bằng Email & Mật khẩu'}
            </button>
          )}
        </div>

        {supabaseAvailable && showEmailForm && (
          <form onSubmit={handlePasswordSubmit} className="text-left space-y-3 pt-2 border-t border-slate-100">
            {isSignUp && (
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Họ và tên"
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            )}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email công việc / Gmail"
              className="w-full min-h-[42px] px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mật khẩu"
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60"
            >
              <KeyRound className="h-4 w-4" />
              <span>{isSignUp ? 'Tạo tài khoản' : 'Đăng nhập'}</span>
            </button>
            <button
              type="button"
              onClick={() => setIsSignUp((v) => !v)}
              className="w-full text-center text-xs text-blue-600 hover:underline"
            >
              {isSignUp ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có mật khẩu? Đăng ký'}
            </button>
          </form>
        )}

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 text-left">
            {error}
          </div>
        )}

        {info && (
          <div role="status" className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800 text-left">
            {info}
          </div>
        )}
      </div>
    </div>
  );
}
