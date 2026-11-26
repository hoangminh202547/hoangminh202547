import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Image as ImageIcon } from 'lucide-react';
import { createSignedMediaUrl } from '../lib/supabaseOps';

interface SignedMediaThumbProps {
  client: SupabaseClient | null;
  thumbPath: string;
  fullPath?: string;
  alt: string;
  className?: string;
  onOpenFull?: (url: string) => void;
}

export function SignedMediaThumb({
  client,
  thumbPath,
  fullPath,
  alt,
  className = 'h-14 w-14 rounded-lg object-cover border border-slate-200',
  onOpenFull,
}: SignedMediaThumbProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(thumbPath));

  useEffect(() => {
    let cancelled = false;
    if (!client || !thumbPath) {
      setThumbUrl(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void createSignedMediaUrl(client, thumbPath).then((url) => {
      if (!cancelled) {
        setThumbUrl(url);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, thumbPath]);

  const handleClick = async () => {
    if (!onOpenFull) return;
    if (!client) {
      if (thumbUrl) onOpenFull(thumbUrl);
      return;
    }
    const targetPath = fullPath || thumbPath;
    const url = await createSignedMediaUrl(client, targetPath);
    if (url) onOpenFull(url);
  };

  if (!thumbPath) return null;

  if (loading) {
    return (
      <div className={`${className} bg-slate-100 animate-pulse flex items-center justify-center`}>
        <ImageIcon className="h-4 w-4 text-slate-400" />
      </div>
    );
  }

  if (!thumbUrl) {
    return (
      <div className={`${className} bg-slate-100 flex items-center justify-center text-slate-400`}>
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group relative inline-block focus:outline-none focus:ring-2 focus:ring-blue-600 rounded-lg"
      title="Xem ảnh đầy đủ"
    >
      <img src={thumbUrl} alt={alt} loading="lazy" className={className} />
    </button>
  );
}
