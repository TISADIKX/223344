import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
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

  const usedTokens = tokenAllowance?.usedTokens || 0;
  const isLimitReached = usedTokens >= dailyTokenLimit;
  const usagePercentDisplay = Math.min(100, Math.round((usedTokens / dailyTokenLimit) * 100));
  const usagePercentSvg = Math.max(0, Math.min(100, (usedTokens / dailyTokenLimit) * 100));
  const remainingTokens = Math.max(0, dailyTokenLimit - usedTokens);

  const resetTimeStr = tokenAllowance?.resetAt
    ? formatResetCountdown(tokenAllowance.resetAt, nowTick)
    : '24h';

  const userInitial = (currentUser.name || currentUser.email || 'U')
    .trim()
    .charAt(0)
    .toUpperCase();

  const handleClose = () => {
    setSubView('main');
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 select-none"
          onClick={handleClose}
        >
          <motion.div
            id="profile-mini-panel"
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="w-full max-w-[280px] sm:max-w-[300px] bg-[#252525] rounded-3xl p-3.5 shadow-2xl border border-white/10 text-white relative flex flex-col space-y-3 origin-center"
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

              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                onClick={handleClose}
                className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition cursor-pointer ml-auto"
                title="Close"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </motion.button>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {/* ---------------- VIEW 1: MAIN ---------------- */}
              {subView === 'main' && (
                <motion.div
                  key="main"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="space-y-2.5"
                >
                  {/* Top User Card */}
                  <div className="bg-[#2e2e2e] border border-white/[0.08] rounded-2xl p-2.5 flex items-center gap-2.5 shadow-sm">
                    <div className="relative shrink-0">
                      {currentUser.avatarUrl ? (
                        <img
                          src={currentUser.avatarUrl}
                          alt={currentUser.name}
                          referrerPolicy="no-referrer"
                          className="w-10 h-10 rounded-full object-cover border border-white/10 bg-black/40"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#464646] to-[#323232] border border-white/10 flex items-center justify-center text-[15px] font-semibold text-white">
                          {userInitial}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-white truncate leading-snug">
                        {currentUser.name}
                      </p>
                      <p className="text-[11px] text-[#9e9e9e] truncate leading-tight">
                        {currentUser.email}
                      </p>
                    </div>
                  </div>

                  {/* Usage Button */}
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setSubView('usage')}
                    className="w-full h-11 px-3.5 bg-[#2e2e2e] hover:bg-[#383838] active:bg-[#404040] border border-white/[0.08] hover:border-white/15 rounded-2xl flex items-center gap-3 transition cursor-pointer text-left"
                  >
                    <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-300">
                      <span className="material-symbols-outlined text-[18px]">bar_chart</span>
                    </div>
                    <span className="text-[13.5px] font-medium text-white flex-1">Usage</span>
                    <span className="text-[11px] text-gray-400 tabular-nums">
                      {formatTokenUsageValue(usedTokens)}/100k
                    </span>
                    <span className="material-symbols-outlined text-[16px] text-gray-400">
                      chevron_right
                    </span>
                  </motion.button>

                  {/* Settings Button */}
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setSubView('settings')}
                    className="w-full h-11 px-3.5 bg-[#2e2e2e] hover:bg-[#383838] active:bg-[#404040] border border-white/[0.08] hover:border-white/15 rounded-2xl flex items-center gap-3 transition cursor-pointer text-left"
                  >
                    <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-300">
                      <span className="material-symbols-outlined text-[18px]">settings</span>
                    </div>
                    <span className="text-[13.5px] font-medium text-white flex-1">Settings</span>
                    <span className="material-symbols-outlined text-[16px] text-gray-400">
                      chevron_right
                    </span>
                  </motion.button>

                  {/* Sign out Button (under Settings) */}
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    onClick={() => {
                      handleClose();
                      onLogout();
                    }}
                    className="w-full h-11 px-3.5 bg-[#2e2e2e] hover:bg-[#383838] active:bg-[#404040] border border-white/[0.08] hover:border-white/15 rounded-2xl flex items-center gap-3 transition cursor-pointer text-left"
                    title="Sign out of account"
                  >
                    <div className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-300">
                      <span className="material-symbols-outlined text-[18px]">logout</span>
                    </div>
                    <span className="text-[13.5px] font-medium text-white flex-1">Sign out</span>
                  </motion.button>
                </motion.div>
              )}

              {/* ---------------- VIEW 2: USAGE DETAIL VIEW ---------------- */}
              {subView === 'usage' && (
                <motion.div
                  key="usage"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="space-y-3 pt-0.5"
                >
                  <div className="bg-[#2e2e2e] border border-white/[0.08] rounded-2xl p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-white">Daily Token Allowance</span>
                      <span className="text-[10px] text-gray-400">Resets in {resetTimeStr}</span>
                    </div>

                    <div className="my-1.5 h-1.5 rounded-full overflow-hidden bg-[#191919]">
                      <motion.div
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: usagePercentSvg / 100 }}
                        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                        style={{ transformOrigin: 'left' }}
                        className={`h-full w-full rounded-full ${
                          isLimitReached ? 'bg-amber-400' : 'bg-blue-400'
                        }`}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] tabular-nums text-gray-300">
                      <span>{formatTokenUsageValue(usedTokens)} used</span>
                      <span className="font-semibold text-white">{usagePercentDisplay}%</span>
                    </div>

                    <div className="pt-2 border-t border-white/[0.08] grid grid-cols-2 gap-2 text-[11px]">
                      <div className="bg-[#1f1f1f] p-2 rounded-xl border border-white/[0.08]">
                        <p className="text-[10px] text-gray-400">Remaining</p>
                        <p className="text-[12.5px] font-semibold text-emerald-400 tabular-nums">
                          {formatTokenUsageValue(remainingTokens)}
                        </p>
                      </div>
                      <div className="bg-[#1f1f1f] p-2 rounded-xl border border-white/[0.08]">
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
                </motion.div>
              )}

              {/* ---------------- VIEW 3: SETTINGS DETAIL VIEW ---------------- */}
              {subView === 'settings' && (
                <motion.div
                  key="settings"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="space-y-3 pt-0.5 max-h-[340px] overflow-y-auto pr-0.5"
                >
                  <div className="bg-[#2e2e2e] border border-white/[0.08] rounded-2xl p-2.5 space-y-2">
                    <p className="text-[12px] font-semibold text-white leading-tight">Photo Generation</p>

                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11.5px] text-[#9e9e9e] shrink-0">Aspect Ratio</label>
                      <select
                        value={genSettings.photoAspectRatio}
                        onChange={(e) =>
                          onUpdateGenSettings('photoAspectRatio', e.target.value as PhotoAspectRatio)
                        }
                        className="h-7 px-2 rounded-lg bg-[#1f1f1f] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                      >
                        <option value="1:1">1:1</option>
                        <option value="16:9">16:9</option>
                        <option value="9:16">9:16</option>
                        <option value="4:3">4:3</option>
                        <option value="3:4">3:4</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11.5px] text-[#9e9e9e] shrink-0">Quality</label>
                      <select
                        value={genSettings.photoQuality}
                        onChange={(e) =>
                          onUpdateGenSettings('photoQuality', e.target.value as PhotoQuality)
                        }
                        className="h-7 px-2 rounded-lg bg-[#1f1f1f] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                      >
                        <option value="standard">Standard</option>
                        <option value="hd">HD</option>
                        <option value="ultra">Ultra HD</option>
                      </select>
                    </div>
                  </div>

                  <div className="bg-[#2e2e2e] border border-white/[0.08] rounded-2xl p-2.5 space-y-2">
                    <p className="text-[12px] font-semibold text-white leading-tight">Video Generation</p>

                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11.5px] text-[#9e9e9e] shrink-0">Duration</label>
                      <select
                        value={genSettings.videoDuration}
                        onChange={(e) =>
                          onUpdateGenSettings('videoDuration', Number(e.target.value) as VideoDuration)
                        }
                        className="h-7 px-2 rounded-lg bg-[#1f1f1f] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                      >
                        <option value={5}>5 seconds</option>
                        <option value={10}>10 seconds</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11.5px] text-[#9e9e9e] shrink-0">Aspect Ratio</label>
                      <select
                        value={genSettings.videoAspectRatio}
                        onChange={(e) =>
                          onUpdateGenSettings('videoAspectRatio', e.target.value as VideoAspectRatio)
                        }
                        className="h-7 px-2 rounded-lg bg-[#1f1f1f] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
                      >
                        <option value="16:9">16:9</option>
                        <option value="9:16">9:16</option>
                        <option value="1:1">1:1</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11.5px] text-[#9e9e9e] shrink-0">Quality</label>
                      <select
                        value={genSettings.videoQuality}
                        onChange={(e) =>
                          onUpdateGenSettings('videoQuality', e.target.value as VideoQuality)
                        }
                        className="h-7 px-2 rounded-lg bg-[#1f1f1f] border border-white/10 text-[11.5px] text-white outline-none focus:border-white/30 cursor-pointer min-w-[110px]"
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
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bottom Terms & Privacy subtle footer */}
            <div className="pt-1 border-t border-white/[0.08] flex items-center justify-center gap-2 text-[10px] text-gray-400">
              <span>Privacy Policy</span>
              <span>·</span>
              <span>Terms of Service</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
