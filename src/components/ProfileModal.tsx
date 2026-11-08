import React, { useState } from 'react';
import {
  UserAccount,
  UserTokenAllowance,
  GenerationSettings,
  PhotoQuality,
  PhotoAspectRatio,
  VideoDuration,
  VideoAspectRatio,
  VideoQuality,
} from '../types';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserAccount;
  tokenAllowance: UserTokenAllowance | null;
  nowTick: number;
  genSettings: GenerationSettings;
  onUpdateGenSettings: <K extends keyof GenerationSettings>(
    key: K,
    value: GenerationSettings[K]
  ) => void;
  onLogout: () => void;
  formatTokenUsageValue: (tokens: number) => string;
  formatResetCountdown: (resetAt: number, now: number) => string;
  dailyTokenLimit: number;
}

type ProfileSubView = 'main' | 'usage' | 'settings';

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  tokenAllowance,
  nowTick,
  genSettings,
  onUpdateGenSettings,
  onLogout,
  formatTokenUsageValue,
  formatResetCountdown,
  dailyTokenLimit,
}) => {
  const [subView, setSubView] = useState<ProfileSubView>('main');
  const [showAccountDropdown, setShowAccountDropdown] = useState(false);

  if (!isOpen) return null;

  const usedTokens = tokenAllowance?.usedTokens || 0;
  const isLimitReached = usedTokens >= dailyTokenLimit;
  const usagePercentDisplay = Math.min(100, Math.round((usedTokens / dailyTokenLimit) * 100));
  const usagePercentSvg = Math.max(0, Math.min(100, (usedTokens / dailyTokenLimit) * 100));
  const remainingTokens = Math.max(0, dailyTokenLimit - usedTokens);

  const resetTimeStr = tokenAllowance?.resetAt
    ? formatResetCountdown(tokenAllowance.resetAt, nowTick)
    : '24h';

  // Get user initials for avatar fallback
  const userInitial = (currentUser.name || currentUser.email || 'U')
    .trim()
    .charAt(0)
    .toUpperCase();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 animate-fade-in select-none"
      onClick={() => {
        setSubView('main');
        setShowAccountDropdown(false);
        onClose();
      }}
    >
      <div
        id="profile-mini-panel"
        className="w-full max-w-[280px] sm:max-w-[300px] bg-[#14151a] rounded-3xl p-3.5 shadow-2xl border border-white/10 text-white relative flex flex-col space-y-3 origin-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header bar with close button & optional Back button */}
        <div className="flex items-center justify-between px-1 pt-0.5">
          {subView !== 'main' ? (
            <button
              type="button"
              onClick={() => setSubView('main')}
              className="flex items-center gap-1 text-[12px] text-gray-400 hover:text-white transition cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">arrow_back</span>
              <span className="font-medium capitalize">{subView}</span>
            </button>
          ) : (
            <span className="text-[12px] font-semibold text-gray-400 tracking-tight">Account</span>
          )}

          <button
            type="button"
            onClick={() => {
              setSubView('main');
              setShowAccountDropdown(false);
              onClose();
            }}
            className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition cursor-pointer ml-auto"
            title="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* ---------------- VIEW 1: MAIN (Matches Attached Photo Exactly) ---------------- */}
        {subView === 'main' && (
          <div className="space-y-2.5">
            {/* Top User Card (Pill style matching reference screenshot) */}
            <div className="bg-[#1c1d24] border border-white/5 rounded-2xl p-2.5 flex items-center justify-between gap-2 shadow-sm">
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Avatar with subtle edit badge */}
                <div className="relative shrink-0">
                  {currentUser.avatarUrl ? (
                    <img
                      src={currentUser.avatarUrl}
                      alt={currentUser.name}
                      className="w-10 h-10 rounded-full object-cover border border-white/10 bg-black/40"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#3b3e4a] to-[#252731] border border-white/10 flex items-center justify-center text-[15px] font-semibold text-white">
                      {userInitial}
                    </div>
                  )}
                  {/* Subtle edit pen icon badge */}
                  <div
                    className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-[#14151a] border border-white/20 flex items-center justify-center text-[9px] text-gray-300"
                    title="Account profile"
                  >
                    <span className="material-symbols-outlined text-[10px]">edit</span>
                  </div>
                </div>

                {/* Name & Email */}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-white truncate leading-snug">
                    {currentUser.name}
                  </p>
                  <p className="text-[11px] text-[#9aa0a6] truncate leading-tight">
                    {currentUser.email}
                  </p>
                </div>
              </div>

              {/* Chevron toggle dropdown button */}
              <button
                type="button"
                onClick={() => setShowAccountDropdown((prev) => !prev)}
                className="w-7 h-7 rounded-lg bg-[#272933] hover:bg-[#313441] border border-white/5 flex items-center justify-center text-gray-300 hover:text-white transition cursor-pointer shrink-0"
                title="Account options"
              >
                <span className="material-symbols-outlined text-[16px]">
                  {showAccountDropdown ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}
                </span>
              </button>
            </div>

            {/* Collapsible Account Options (Sign out) */}
            {showAccountDropdown && (
              <div className="bg-[#1c1d24] border border-white/10 rounded-xl p-2 animate-fade-in text-[11.5px]">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onLogout();
                    }}
                    className="h-7 px-2.5 rounded-lg bg-white text-gray-950 hover:bg-gray-200 active:scale-[0.98] transition cursor-pointer text-[11px] font-semibold shadow-sm inline-flex items-center gap-1"
                    title="Sign out of account"
                  >
                    <span className="material-symbols-outlined text-[13px]">logout</span>
                    <span>Sign out</span>
                  </button>
                </div>
              </div>
            )}

            {/* Usage Pill Button (Matches reference screenshot) */}
            <button
              type="button"
              onClick={() => setSubView('usage')}
              className="w-full h-11 px-3.5 bg-[#1c1d24] hover:bg-[#252731] active:bg-[#2b2d38] border border-white/5 hover:border-white/10 rounded-2xl flex items-center gap-3 transition cursor-pointer text-left"
            >
              <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-300">
                <span className="material-symbols-outlined text-[18px]">bar_chart</span>
              </div>
              <span className="text-[13.5px] font-medium text-white flex-1">Usage</span>
              <span className="text-[11px] text-gray-400 tabular-nums">
                {formatTokenUsageValue(usedTokens)}/100k
              </span>
              <span className="material-symbols-outlined text-[16px] text-gray-500">
                chevron_right
              </span>
            </button>

            {/* Settings Pill Button (Matches reference screenshot) */}
            <button
              type="button"
              onClick={() => setSubView('settings')}
              className="w-full h-11 px-3.5 bg-[#1c1d24] hover:bg-[#252731] active:bg-[#2b2d38] border border-white/5 hover:border-white/10 rounded-2xl flex items-center gap-3 transition cursor-pointer text-left"
            >
              <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-300">
                <span className="material-symbols-outlined text-[18px]">settings</span>
              </div>
              <span className="text-[13.5px] font-medium text-white flex-1">Settings</span>
              <span className="material-symbols-outlined text-[16px] text-gray-500">
                chevron_right
              </span>
            </button>
          </div>
        )}

        {/* ---------------- VIEW 2: USAGE DETAIL VIEW ---------------- */}
        {subView === 'usage' && (
          <div className="space-y-3 pt-0.5">
            <div className="bg-[#1c1d24] border border-white/5 rounded-2xl p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-white">Daily Token Allowance</span>
                <span className="text-[10px] text-gray-400">Resets in {resetTimeStr}</span>
              </div>

              {/* Progress bar */}
              <div className="my-1.5">
                <svg
                  viewBox="0 0 100 4"
                  preserveAspectRatio="none"
                  className="w-full h-1.5 rounded-full overflow-hidden block bg-[#2a2c32]"
                  aria-hidden="true"
                >
                  {usagePercentSvg > 0 && (
                    <rect
                      x="0"
                      y="0"
                      width={usagePercentSvg}
                      height="4"
                      rx="2"
                      className={isLimitReached ? 'fill-amber-400' : 'fill-blue-400'}
                    />
                  )}
                </svg>
              </div>

              <div className="flex items-center justify-between text-[11px] tabular-nums text-gray-300">
                <span>{formatTokenUsageValue(usedTokens)} used</span>
                <span className="font-semibold text-white">{usagePercentDisplay}%</span>
              </div>

              <div className="pt-2 border-t border-white/5 grid grid-cols-2 gap-2 text-[11px]">
                <div className="bg-[#14151a] p-2 rounded-xl border border-white/5">
                  <p className="text-[10px] text-gray-400">Remaining</p>
                  <p className="text-[12.5px] font-semibold text-emerald-400 tabular-nums">
                    {formatTokenUsageValue(remainingTokens)}
                  </p>
                </div>
                <div className="bg-[#14151a] p-2 rounded-xl border border-white/5">
                  <p className="text-[10px] text-gray-400">Total Limit</p>
                  <p className="text-[12.5px] font-semibold text-white tabular-nums">100,000</p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSubView('main')}
              className="w-full h-8 rounded-xl bg-white/5 hover:bg-white/10 text-[12px] font-medium text-gray-300 hover:text-white transition cursor-pointer"
            >
              Back to Account
            </button>
          </div>
        )}

        {/* ---------------- VIEW 3: SETTINGS DETAIL VIEW ---------------- */}
        {subView === 'settings' && (
          <div className="space-y-3 pt-0.5 max-h-[340px] overflow-y-auto pr-0.5">
            {/* Photo Generation Settings */}
            <div className="bg-[#1c1d24] border border-white/5 rounded-2xl p-2.5 space-y-2">
              <p className="text-[12px] font-semibold text-white leading-tight">Photo Generation</p>

              {/* Photo Aspect Ratio */}
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11.5px] text-[#9aa0a6] shrink-0">Aspect Ratio</label>
                <select
                  value={genSettings.photoAspectRatio}
                  onChange={(e) =>
                    onUpdateGenSettings('photoAspectRatio', e.target.value as PhotoAspectRatio)
                  }
                  className="h-7 px-2 rounded-lg bg-[#252731] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                >
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="4:3">4:3</option>
                  <option value="3:4">3:4</option>
                </select>
              </div>

              {/* Photo Quality */}
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11.5px] text-[#9aa0a6] shrink-0">Quality</label>
                <select
                  value={genSettings.photoQuality}
                  onChange={(e) =>
                    onUpdateGenSettings('photoQuality', e.target.value as PhotoQuality)
                  }
                  className="h-7 px-2 rounded-lg bg-[#252731] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                >
                  <option value="standard">Standard</option>
                  <option value="hd">HD</option>
                  <option value="ultra">Ultra HD</option>
                </select>
              </div>
            </div>

            {/* Video Generation Settings */}
            <div className="bg-[#1c1d24] border border-white/5 rounded-2xl p-2.5 space-y-2">
              <p className="text-[12px] font-semibold text-white leading-tight">Video Generation</p>

              {/* Video Duration */}
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11.5px] text-[#9aa0a6] shrink-0">Duration</label>
                <select
                  value={genSettings.videoDuration}
                  onChange={(e) =>
                    onUpdateGenSettings('videoDuration', Number(e.target.value) as VideoDuration)
                  }
                  className="h-7 px-2 rounded-lg bg-[#252731] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                >
                  <option value={5}>5 seconds</option>
                  <option value={10}>10 seconds</option>
                </select>
              </div>

              {/* Video Aspect Ratio */}
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11.5px] text-[#9aa0a6] shrink-0">Aspect Ratio</label>
                <select
                  value={genSettings.videoAspectRatio}
                  onChange={(e) =>
                    onUpdateGenSettings('videoAspectRatio', e.target.value as VideoAspectRatio)
                  }
                  className="h-7 px-2 rounded-lg bg-[#252731] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                >
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
              </div>

              {/* Video Quality */}
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11.5px] text-[#9aa0a6] shrink-0">Quality</label>
                <select
                  value={genSettings.videoQuality}
                  onChange={(e) =>
                    onUpdateGenSettings('videoQuality', e.target.value as VideoQuality)
                  }
                  className="h-7 px-2 rounded-lg bg-[#252731] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                >
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSubView('main')}
              className="w-full h-8 rounded-xl bg-white/5 hover:bg-white/10 text-[12px] font-medium text-gray-300 hover:text-white transition cursor-pointer"
            >
              Back to Account
            </button>
          </div>
        )}

        {/* Bottom Terms & Privacy subtle footer */}
        <div className="pt-1 border-t border-white/5 flex items-center justify-center gap-2 text-[10px] text-gray-500">
          <span>Privacy Policy</span>
          <span>•</span>
          <span>Terms of Service</span>
        </div>
      </div>
    </div>
  );
};
