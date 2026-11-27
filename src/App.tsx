/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { marked } from 'marked';
import { HistorySidebar } from './components/HistorySidebar';
import { AuthModal } from './components/AuthModal';
import { ProfileModal } from './components/ProfileModal';
import { VoiceAudioPlayer } from './components/VoiceAudioPlayer';
import {
  applyCanvasPhotoFilterPlan,
  conformVideoToSettingsInBrowser,
  editPhotoDirectlyInBrowser,
  generateMultiKeyframeMotionVideoInBrowser,
  generatePhotoDirectlyInBrowser,
  pollAiHordeImageInBrowser,
} from './lib/mediaFallback';
import {
  auth,
  onAuthStateChanged,
  logOutFromFirebase,
  initAnalytics,
  saveSessionToFirestore,
  deleteSessionFromFirestore,
  subscribeToUserSessions,
} from './firebase';
import {
  ChatMode,
  AttachedMedia,
  RecordedVoice,
  MessageAttachment,
  AspectRatio,
  PhotoAspectRatio,
  PhotoQuality,
  VideoAspectRatio,
  VideoDuration,
  VideoQuality,
  GenerationSettings,
  GeneratedPhoto,
  GeneratedVideo,
  Message,
  UserAccount,
  UserTokenAllowance,
  ChatSession,
} from './types';

const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  photoQuality: 'hd',
  photoAspectRatio: '1:1',
  videoDuration: 10,
  videoAspectRatio: '16:9',
  videoQuality: '720p',
};

const loadSavedGenerationSettings = (): GenerationSettings => {
  try {
    const raw = localStorage.getItem('gutiai_generation_settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        photoQuality:
          parsed?.photoQuality === 'standard' || parsed?.photoQuality === 'hd' || parsed?.photoQuality === 'ultra'
            ? parsed.photoQuality
            : DEFAULT_GENERATION_SETTINGS.photoQuality,
        photoAspectRatio:
          parsed?.photoAspectRatio === '1:1' ||
          parsed?.photoAspectRatio === '16:9' ||
          parsed?.photoAspectRatio === '9:16' ||
          parsed?.photoAspectRatio === '4:3' ||
          parsed?.photoAspectRatio === '3:4'
            ? parsed.photoAspectRatio
            : DEFAULT_GENERATION_SETTINGS.photoAspectRatio,
        videoDuration:
          Number(parsed?.videoDuration) === 5
            ? 5
            : Number(parsed?.videoDuration) === 10
            ? 10
            : DEFAULT_GENERATION_SETTINGS.videoDuration,
        videoAspectRatio:
          parsed?.videoAspectRatio === '16:9' ||
          parsed?.videoAspectRatio === '9:16' ||
          parsed?.videoAspectRatio === '1:1'
            ? parsed.videoAspectRatio
            : DEFAULT_GENERATION_SETTINGS.videoAspectRatio,
        videoQuality:
          parsed?.videoQuality === '480p' ||
          parsed?.videoQuality === '720p' ||
          parsed?.videoQuality === '1080p'
            ? parsed.videoQuality
            : DEFAULT_GENERATION_SETTINGS.videoQuality,
      };
    }
  } catch (_e) {}
  return DEFAULT_GENERATION_SETTINGS;
};

const MAX_VOICE_SECONDS = 300; // 5 minutes max voice recording duration
const DAILY_TOKEN_LIMIT = 100_000; // 100k daily token allowance per logged-in user
const TOKEN_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // Resets every 24 hours
const PHOTO_TOKEN_COST = 500; // 500 tokens per photo generation
const VIDEO_TOKEN_COST = 1_000; // 1k tokens per video generation

const getTokenStorageKey = (email: string) =>
  `gutiai_token_allowance_${email.trim().toLowerCase()}`;

const loadOrCreateUserAllowance = (email: string): UserTokenAllowance => {
  const key = getTokenStorageKey(email);
  const now = Date.now();
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      const resetAt = Number(parsed?.resetAt) || 0;
      const usedTokens = Number(parsed?.usedTokens) || 0;
      if (resetAt > now) {
        return {
          usedTokens: Math.max(0, Math.min(DAILY_TOKEN_LIMIT, usedTokens)),
          limitTokens: DAILY_TOKEN_LIMIT,
          resetAt,
        };
      }
    }
  } catch (_e) {}

  const fresh: UserTokenAllowance = {
    usedTokens: 0,
    limitTokens: DAILY_TOKEN_LIMIT,
    resetAt: now + TOKEN_RESET_INTERVAL_MS,
  };
  try {
    localStorage.setItem(key, JSON.stringify(fresh));
  } catch (_e) {}
  return fresh;
};

const formatTokenUsageValue = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= DAILY_TOKEN_LIMIT) return '100k';
  if (tokens < 1000) return `${Math.round(tokens)}`;
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
};

const formatResetCountdown = (resetAt: number, nowMs: number): string => {
  const diffMs = Math.max(0, resetAt - nowMs);
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

// Strict per-user storage isolation helpers (no shared global chat history key)
const getUserScopeKey = (user: UserAccount | null): string | null => {
  if (!user) return null;
  if (user.uid && user.uid.trim()) return `uid_${user.uid.trim()}`;
  if (user.email && user.email.trim()) return `email_${user.email.trim().toLowerCase()}`;
  return null;
};

const getUserHistoryStorageKey = (scope: string) => `bloopx_chat_history_${scope}`;
const getUserActiveSessionStorageKey = (scope: string) => `bloopx_active_session_${scope}`;

const loadUserSessionsFromStorage = (scope: string): ChatSession[] => {
  try {
    const raw = localStorage.getItem(getUserHistoryStorageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s: any) => s && typeof s.id === 'string' && (!s.userId || s.userId === scope))
      .map((s: any) => ({
        ...s,
        userId: scope,
      }));
  } catch (_e) {
    return [];
  }
};

const compactSessionForLocalStorage = (s: ChatSession): ChatSession => ({
  ...s,
  messages: (s.messages || []).map((m) => ({
    ...m,
    attachments: m.attachments?.map((att) =>
      att.previewUrl && att.previewUrl.length > 45000
        ? { ...att, previewUrl: '' }
        : att
    ),
    generatedPhoto:
      m.generatedPhoto && m.generatedPhoto.url.length > 150000
        ? { ...m.generatedPhoto, url: '' }
        : m.generatedPhoto,
  })),
});

const saveUserSessionsToStorage = (scope: string, list: ChatSession[]) => {
  const storageKey = getUserHistoryStorageKey(scope);
  const scoped = list
    .filter((s) => !s.userId || s.userId === scope)
    .map((s) => ({ ...s, userId: scope }));
  try {
    localStorage.setItem(storageKey, JSON.stringify(scoped));
  } catch (_quotaErr) {
    try {
      // Keep latest 3 sessions intact and compact older inline base64 previews so history never silently drops
      const compacted = scoped.map((s, idx) =>
        idx < 3 ? s : compactSessionForLocalStorage(s)
      );
      localStorage.setItem(storageKey, JSON.stringify(compacted));
    } catch (_secondErr) {
      try {
        const allCompacted = scoped.slice(0, 15).map(compactSessionForLocalStorage);
        localStorage.setItem(storageKey, JSON.stringify(allCompacted));
      } catch (_e) {}
    }
  }
};

const loadUserActiveSessionIdFromStorage = (scope: string): string | null => {
  try {
    return localStorage.getItem(getUserActiveSessionStorageKey(scope)) || null;
  } catch (_e) {
    return null;
  }
};

const saveUserActiveSessionIdToStorage = (scope: string, sessionId: string | null) => {
  try {
    if (sessionId) {
      localStorage.setItem(getUserActiveSessionStorageKey(scope), sessionId);
    } else {
      localStorage.removeItem(getUserActiveSessionStorageKey(scope));
    }
  } catch (_e) {}
};

export default function App() {
  // Strictly per-user Chat Sessions History (never preloaded from a global shared key)
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Responsive sidebar open/close state (overlay drawer, closed by default for full screen)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Chat & Input state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedMedia[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState('Thinking...');
  const [pendingMode, setPendingMode] = useState<ChatMode | null>(null);
  const [pendingPhotoAspect, setPendingPhotoAspect] = useState<PhotoAspectRatio>('1:1');
  const [pendingVideoAspect, setPendingVideoAspect] = useState<VideoAspectRatio>('16:9');
  const [videoProgress, setVideoProgress] = useState<number>(0);
  const [videoBlobUrls, setVideoBlobUrls] = useState<Record<string, string>>({});
  const [showUploadMenu, setShowUploadMenu] = useState(false);

  // Chat Mode: 'chat', 'photo', 'video'
  const [chatMode, setChatMode] = useState<ChatMode>('chat');
  const [showModeMenu, setShowModeMenu] = useState(false);

  // User-configurable Photo & Video Generation Settings
  const [genSettings, setGenSettings] = useState<GenerationSettings>(loadSavedGenerationSettings);

  const updateGenSettings = <K extends keyof GenerationSettings>(
    key: K,
    value: GenerationSettings[K]
  ) => {
    setGenSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem('gutiai_generation_settings', JSON.stringify(next));
      } catch (_e) {}
      return next;
    });
  };

  // Active clicked photo state (for showing download icon on under right side)
  const [activePhotoIdx, setActivePhotoIdx] = useState<number | null>(null);

  // User, Login Modal, Settings Menu & 100k Daily Token Allowance state
  const [currentUser, setCurrentUser] = useState<UserAccount | null>(null);
  const [tokenAllowance, setTokenAllowance] = useState<UserTokenAllowance | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Voice recording state (max 5 minutes)
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedVoice, setRecordedVoice] = useState<RecordedVoice | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Refs
  const chatCanvasRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const docFileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef<boolean>(false);
  const speechRecognitionRef = useRef<any>(null);
  const speechTranscriptRef = useRef<string>('');
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingSecondsRef = useRef<number>(0);
  const videoProgressFloorRef = useRef<number>(0);
  const videoTickCountRef = useRef<number>(0);
  const videoBlobUrlsRef = useRef<Record<string, string>>({});
  const sessionsRef = useRef<ChatSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeScopeRef = useRef<string | null>(null);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const currentScope = getUserScopeKey(currentUser);

  // Subscribe to Firebase Auth on mount & clear legacy shared un-scoped history keys
  useEffect(() => {
    initAnalytics().catch(() => {});

    // Purge legacy un-scoped global history keys so old sessions never leak across accounts
    try {
      localStorage.removeItem('gutiai_chat_history');
      localStorage.removeItem('gutiai_active_session_id');
    } catch (_e) {}

    let isMounted = true;
    let authSettled = false;

    const savedUserRaw = localStorage.getItem('gutiai_user_session');
    if (savedUserRaw) {
      try {
        const parsed = JSON.parse(savedUserRaw);
        if (parsed && (parsed.uid || parsed.email)) {
          setCurrentUser(parsed);
        }
      } catch (_e) {
        localStorage.removeItem('gutiai_user_session');
      }
    }

    if (typeof (auth as any).authStateReady === 'function') {
      (auth as any).authStateReady().then(() => {
        authSettled = true;
        if (isMounted && !auth.currentUser) {
          localStorage.removeItem('gutiai_user_session');
          setCurrentUser(null);
        }
      }).catch(() => {});
    }

    // Subscribe to real-time Firebase Auth state changes
    const unsubscribeAuth = onAuthStateChanged(auth, (fbUser) => {
      if (!isMounted) return;
      if (fbUser) {
        const user: UserAccount = {
          uid: fbUser.uid,
          name: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : 'User'),
          email: fbUser.email || '',
          avatarUrl: fbUser.photoURL || undefined,
        };
        setCurrentUser(user);
        try {
          localStorage.setItem('gutiai_user_session', JSON.stringify(user));
        } catch (_e) {}
      } else if (authSettled) {
        localStorage.removeItem('gutiai_user_session');
        setCurrentUser(null);
      }
    });

    return () => {
      isMounted = false;
      unsubscribeAuth();
    };
  }, []);

  // Strict per-account history isolation & real-time Firestore synchronization
  useEffect(() => {
    const prevScope = activeScopeRef.current;
    activeScopeRef.current = currentScope;

    if (prevScope !== currentScope) {
      // Clear previous account's transient workspace immediately on sign-out or account switch
      setMessages([]);
      setActiveSessionId(null);
      setInputText('');
      setAttachedFiles([]);
      setRecordedVoice(null);
      setActivePhotoIdx(null);
      setIsThinking(false);
      setPendingMode(null);
      setVideoProgress(0);
      setIsSidebarOpen(false);
      setShowProfileModal(false);
    }

    if (!currentScope) {
      sessionsRef.current = [];
      setSessions([]);
      return;
    }

    // Load only this specific user's scoped local cache while Firestore syncs
    const scopedSessions = loadUserSessionsFromStorage(currentScope);
    sessionsRef.current = scopedSessions;
    setSessions(scopedSessions);

    const savedActiveId = loadUserActiveSessionIdFromStorage(currentScope);
    const matchingActive = savedActiveId
      ? scopedSessions.find((s) => s.id === savedActiveId)
      : undefined;

    if (matchingActive) {
      setActiveSessionId(matchingActive.id);
      setMessages(matchingActive.messages || []);
      if (matchingActive.chatMode) {
        setChatMode(matchingActive.chatMode);
      }
    } else {
      setActiveSessionId(null);
      setMessages([]);
    }

    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (!effectiveUid || auth.currentUser?.uid !== effectiveUid) {
      return;
    }

    const expectedScope = currentScope;
    const unsubscribeSessions = subscribeToUserSessions(
      effectiveUid,
      (cloudSessions) => {
        // Ignore stale snapshot if user already switched accounts
        if (activeScopeRef.current !== expectedScope) return;

        // Always treat this user's Firestore snapshot as authoritative (even when empty!)
        // Preserve only brand-new local optimistic sessions created for THIS user in the last 10s
        const now = Date.now();
        const cloudIds = new Set(cloudSessions.map((s) => s.id));
        const recentLocalOnly = sessionsRef.current.filter(
          (s) =>
            s.userId === expectedScope &&
            !cloudIds.has(s.id) &&
            now - (s.updatedAt || s.createdAt || 0) < 10000
        );

        const merged = [...recentLocalOnly, ...cloudSessions]
          .map((s) => ({ ...s, userId: expectedScope }))
          .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

        sessionsRef.current = merged;
        setSessions(merged);
        saveUserSessionsToStorage(expectedScope, merged);

        const currentActiveId = activeSessionIdRef.current;
        if (currentActiveId) {
          const foundActive = merged.find((s) => s.id === currentActiveId);
          if (!foundActive) {
            setActiveSessionId(null);
            setMessages([]);
          }
        }
      },
      (err) => {
        console.warn('Firestore session listener warning:', err);
      }
    );

    return () => {
      unsubscribeSessions();
    };
  }, [currentScope, currentUser?.uid]);

  // Automatically provision / sync 100k 24-hour token allowance whenever a user logs in
  useEffect(() => {
    if (!currentUser?.email) {
      setTokenAllowance(null);
      return;
    }

    const syncAllowance = () => {
      setNowTick(Date.now());
      const latest = loadOrCreateUserAllowance(currentUser.email);
      setTokenAllowance(latest);
    };

    syncAllowance();
    const interval = setInterval(syncAllowance, 15000);
    return () => clearInterval(interval);
  }, [currentUser]);

  const recordTokenUsage = (deltaTokens: number) => {
    if (!currentUser?.email || deltaTokens <= 0) return;
    const base = loadOrCreateUserAllowance(currentUser.email);
    const updated: UserTokenAllowance = {
      ...base,
      usedTokens: Math.min(DAILY_TOKEN_LIMIT, base.usedTokens + Math.max(1, Math.round(deltaTokens))),
    };
    try {
      localStorage.setItem(getTokenStorageKey(currentUser.email), JSON.stringify(updated));
    } catch (_e) {}
    setTokenAllowance(updated);
    setNowTick(Date.now());
  };

  // Persist sessions strictly under the active user's scope
  useEffect(() => {
    if (!currentScope) return;
    saveUserSessionsToStorage(currentScope, sessions);
  }, [sessions, currentScope]);

  // Persist activeSessionId strictly under the active user's scope
  useEffect(() => {
    if (!currentScope) return;
    saveUserActiveSessionIdToStorage(currentScope, activeSessionId);
  }, [activeSessionId, currentScope]);

  // Auto-scroll chat canvas
  useEffect(() => {
    if (chatCanvasRef.current) {
      chatCanvasRef.current.scrollTop = chatCanvasRef.current.scrollHeight;
    }
  }, [messages, isThinking, pendingMode]);

  // Continuous adaptive monotonic percentage ticker during video generation (never freezes mid-stream)
  useEffect(() => {
    if (!isThinking || pendingMode !== 'video') return;
    videoTickCountRef.current = 0;
    const interval = setInterval(() => {
      videoTickCountRef.current += 1;
      const tick = videoTickCountRef.current;
      setVideoProgress((prev) => {
        if (prev >= 100) return 100;
        const floor = videoProgressFloorRef.current;
        if (floor >= 100) return 100;
        if (prev < floor) {
          return Math.min(floor, prev + 3);
        }
        // Smooth adaptive cadence when waiting on GPU queue, synthesis, or mastering so % never stops at 72%
        const stride = prev < 50 ? 2 : prev < 75 ? 3 : prev < 89 ? 5 : 9;
        if (prev < 98 && tick % stride === 0) {
          return prev + 1;
        }
        return prev;
      });
    }, 320);
    return () => clearInterval(interval);
  }, [isThinking, pendingMode]);

  // Cleanup active voice recording resources and cached video blobs on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.stop();
        } catch (_e) {}
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      Object.values(videoBlobUrlsRef.current).forEach((blobUrl) => {
        URL.revokeObjectURL(blobUrl);
      });
    };
  }, []);

  // Adjust textarea height safely so it never collapses to 0
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scHeight = textareaRef.current.scrollHeight;
      const targetHeight = Math.max(36, Math.min(scHeight || 36, 140));
      textareaRef.current.style.height = `${targetHeight}px`;
    }
  }, [inputText]);

  // Focus prompt input on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Keep outer document/viewport pinned to exact visualViewport height/offset so Android Chrome never shifts up/down
  useLayoutEffect(() => {
    const syncViewportMetrics = () => {
      const vv = window.visualViewport;
      const root = document.documentElement;
      if (vv) {
        root.style.setProperty('--app-height', `${Math.max(320, Math.round(vv.height))}px`);
        root.style.setProperty('--app-offset-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
      } else {
        root.style.setProperty('--app-height', `${Math.max(320, window.innerHeight)}px`);
        root.style.setProperty('--app-offset-top', '0px');
      }
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
      if (root.scrollTop !== 0) {
        root.scrollTop = 0;
      }
      if (document.body.scrollTop !== 0) {
        document.body.scrollTop = 0;
      }
    };

    syncViewportMetrics();
    window.addEventListener('scroll', syncViewportMetrics, { passive: true });
    window.addEventListener('resize', syncViewportMetrics, { passive: true });
    window.addEventListener('orientationchange', syncViewportMetrics, { passive: true });
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('scroll', syncViewportMetrics, { passive: true });
      vv.addEventListener('resize', syncViewportMetrics, { passive: true });
    }
    return () => {
      window.removeEventListener('scroll', syncViewportMetrics);
      window.removeEventListener('resize', syncViewportMetrics);
      window.removeEventListener('orientationchange', syncViewportMetrics);
      if (vv) {
        vv.removeEventListener('scroll', syncViewportMetrics);
        vv.removeEventListener('resize', syncViewportMetrics);
      }
    };
  }, []);

  // Close menus on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || !document.body.contains(target)) return;
      if (!target.closest('#upload-menu') && !target.closest('#add-file-btn')) {
        setShowUploadMenu(false);
      }
      if (!target.closest('#mode-menu') && !target.closest('#mode-selector-btn')) {
        setShowModeMenu(false);
      }

      if (!target.closest('#history-sidebar') && !target.closest('#toggle-sidebar-btn')) {
        setIsSidebarOpen(false);
      }
    };

    document.addEventListener('click', handleOutsideClick);
    return () => document.removeEventListener('click', handleOutsideClick);
  }, []);

  // Format recording seconds to m:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Sanitize rendered markdown HTML cleanly against raw script/event injection
  const renderSafeMarkdown = (markdownText: string): string => {
    const rawHtml = marked.parse(markdownText || '') as string;
    return rawHtml
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<\/?(?:iframe|object|embed|form)[^>]*>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  };

  // Convert File to Base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(file);
    });
  };

  const detectClosestPhotoAspect = (w: number, h: number): PhotoAspectRatio => {
    if (!w || !h) return '1:1';
    const r = w / h;
    const opts: Array<{ aspect: PhotoAspectRatio; val: number }> = [
      { aspect: '1:1', val: 1 },
      { aspect: '16:9', val: 16 / 9 },
      { aspect: '9:16', val: 9 / 16 },
      { aspect: '4:3', val: 4 / 3 },
      { aspect: '3:4', val: 3 / 4 },
    ];
    return opts.reduce((best, cur) =>
      Math.abs(r - cur.val) < Math.abs(r - best.val) ? cur : best
    ).aspect;
  };

  // Optimize & encode uploaded image cleanly to persistent Data URL + aspect ratio
  const prepareImageAttachment = (
    file: File
  ): Promise<{ previewUrl: string; base64Data: string; mimeType: string; aspectRatio: PhotoAspectRatio }> => {
    return new Promise((resolve, reject) => {
      const tempBlob = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const naturalW = img.naturalWidth || 512;
          const naturalH = img.naturalHeight || 512;
          const aspectRatio = detectClosestPhotoAspect(naturalW, naturalH);
          const maxDim = 1024;
          const scale = Math.max(naturalW, naturalH) > maxDim ? maxDim / Math.max(naturalW, naturalH) : 1;
          const targetW = Math.max(1, Math.round(naturalW * scale));
          const targetH = Math.max(1, Math.round(naturalH * scale));

          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas unavailable');

          ctx.drawImage(img, 0, 0, targetW, targetH);
          const outMime = 'image/jpeg';
          let dataUrl = canvas.toDataURL(outMime, 0.84);
          if (dataUrl.length > 1_200_000) {
            dataUrl = canvas.toDataURL(outMime, 0.7);
          }
          const base64Data = dataUrl.split(',')[1] || '';
          URL.revokeObjectURL(tempBlob);
          if (!base64Data) throw new Error('Empty canvas output');
          resolve({ previewUrl: dataUrl, base64Data, mimeType: outMime, aspectRatio });
        } catch (err) {
          URL.revokeObjectURL(tempBlob);
          fileToBase64(file)
            .then((b64) => {
              const mime = file.type || 'image/jpeg';
              resolve({
                previewUrl: `data:${mime};base64,${b64}`,
                base64Data: b64,
                mimeType: mime,
                aspectRatio: '1:1',
              });
            })
            .catch(reject);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(tempBlob);
        fileToBase64(file)
          .then((b64) => {
            const mime = file.type || 'image/jpeg';
            resolve({
              previewUrl: `data:${mime};base64,${b64}`,
              base64Data: b64,
              mimeType: mime,
              aspectRatio: '1:1',
            });
          })
          .catch(reject);
      };
      img.src = tempBlob;
    });
  };

  // Extract chronological JPEG keyframes from uploaded videos so Vision & multimodal AI models can explain any video cleanly
  const prepareVideoAttachment = (
    file: File,
    previewUrl: string
  ): Promise<{ frames: Array<{ data: string; mimeType: string; timeSec: number }>; durationSec: number }> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      let settled = false;
      const frames: Array<{ data: string; mimeType: string; timeSec: number }> = [];
      let durationSec = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        video.removeAttribute('src');
        video.load();
        resolve({ frames, durationSec });
      };

      const overallTimer = setTimeout(finish, 7500);

      const captureCurrentFrame = (timeSec: number) => {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        if (!vw || !vh) return;
        const maxDim = 576;
        const scale = Math.max(vw, vh) > maxDim ? maxDim / Math.max(vw, vh) : 1;
        const cw = Math.max(1, Math.round(vw * scale));
        const ch = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, cw, ch);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
        const b64 = dataUrl.split(',')[1] || '';
        if (b64) {
          frames.push({ data: b64, mimeType: 'image/jpeg', timeSec });
        }
      };

      video.onloadeddata = async () => {
        try {
          durationSec = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          const ratios = durationSec >= 1.2 ? [0.08, 0.35, 0.65, 0.9] : [0.1];
          const targets = ratios.map((r) =>
            durationSec > 0 ? Math.min(Math.max(0.05, durationSec * r), Math.max(0.05, durationSec - 0.1)) : 0
          );

          for (const targetSec of targets) {
            if (settled) break;
            if (durationSec > 0.2) {
              await new Promise<void>((seekResolve) => {
                let seekDone = false;
                const doneSeek = () => {
                  if (!seekDone) {
                    seekDone = true;
                    seekResolve();
                  }
                };
                const t = setTimeout(doneSeek, 1400);
                video.onseeked = () => {
                  clearTimeout(t);
                  doneSeek();
                };
                try {
                  video.currentTime = targetSec;
                } catch {
                  clearTimeout(t);
                  doneSeek();
                }
              });
            }
            captureCurrentFrame(targetSec);
          }
        } catch {
          // Return whatever keyframes were captured
        }
        finish();
      };

      video.onerror = () => finish();
      video.src = previewUrl;
    });
  };

  // Preload & GPU-decode image in memory so it reveals seamlessly inside the creation card
  const preloadImage = (url: string, timeoutMs: number = 8000): Promise<boolean> => {
    return new Promise((resolve) => {
      const img = new Image();
      let done = false;
      const finish = (ok: boolean) => {
        if (!done) {
          done = true;
          resolve(ok);
        }
      };
      img.onload = () => {
        if (typeof img.decode === 'function') {
          img
            .decode()
            .then(() => finish(true))
            .catch(() => finish(true));
        } else {
          finish(true);
        }
      };
      img.onerror = () => finish(false);
      img.src = url;
      setTimeout(() => finish(false), timeoutMs);
    });
  };

  // Preload mastered MP4 into RAM Blob URL so playback is 100% lag-free with zero network buffering
  const preloadVideoInMemory = async (url: string): Promise<void> => {
    if (!url || url.startsWith('blob:') || url.startsWith('data:') || videoBlobUrlsRef.current[url]) {
      return;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return;
      const blob = await res.blob();
      if (blob.size < 4000) return;
      const blobUrl = URL.createObjectURL(blob);
      videoBlobUrlsRef.current[url] = blobUrl;
      setVideoBlobUrls((prev) => ({ ...prev, [url]: blobUrl }));
    } catch {
      // Fallback to direct HTTP Range URL if Blob preload fails
    }
  };

  // Download full-resolution HD image without cropping or blur resampling
  const downloadImage = async (url: string, filename: string) => {
    try {
      let blob: Blob;
      if (url.startsWith('data:')) {
        const arr = url.split(',');
        const mimeMatch = arr[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
          u8arr[n] = bstr.charCodeAt(n);
        }
        blob = new Blob([u8arr], { type: mime });
      } else {
        const res = await fetch(url);
        blob = await res.blob();
      }

      // Safety check: Never download non-image files (e.g. JSON error response)
      if (!blob.type.startsWith('image/')) {
        console.error("Refusing to download non-image file as photo:", blob.type);
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error("Failed to download image", e);
    }
  };

  // Download full 5s / 10s video cleanly via Blob URL
  const downloadVideo = async (url: string, filename: string) => {
    try {
      const sourceUrl = videoBlobUrlsRef.current[url] || videoBlobUrls[url] || url;
      const res = await fetch(sourceUrl);
      if (!res.ok) return;
      const blob = await res.blob();
      const targetName =
        blob.type.includes('webm') && filename.toLowerCase().endsWith('.mp4')
          ? filename.replace(/\.mp4$/i, '.webm')
          : filename;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = targetName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error("Failed to download video", e);
    }
  };


  // Files selection
  const handleFilesSelect = async (files: FileList | File[]) => {
    const filesArray = Array.from(files);
    if (filesArray.length === 0) return;

    setUploadError(null);
    const currentPhotos = attachedFiles.filter(f => f.type === 'image');
    const currentVideos = attachedFiles.filter(f => f.type === 'video');

    const isImageFile = (f: File) =>
      f.type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(f.name);
    const isVideoFile = (f: File) =>
      f.type.startsWith('video/') || /\.(?:mp4|mov|webm|m4v|mkv|avi|3gp)$/i.test(f.name);

    const newPhotos = filesArray.filter(isImageFile);
    const newVideos = filesArray.filter(f => !isImageFile(f) && isVideoFile(f));
    const unsupportedFiles = filesArray.filter(
      f => !isImageFile(f) && !isVideoFile(f)
    );

    if (unsupportedFiles.length > 0 && newPhotos.length === 0 && newVideos.length === 0) {
      setUploadError('Please select an image or video file (PNG, JPG, WebP, or MP4).');
      return;
    }
    if (unsupportedFiles.length > 0) {
      setUploadError('Skipped unsupported file(s). Only image and video files can be attached.');
    }

    const filesToAdd: File[] = [];

    const photoSlots = Math.max(0, 10 - currentPhotos.length);
    if (newPhotos.length > 0 && photoSlots > 0) {
      filesToAdd.push(...newPhotos.slice(0, photoSlots));
    }

    const videoSlots = Math.max(0, 1 - currentVideos.length);
    if (newVideos.length > 0 && videoSlots > 0) {
      filesToAdd.push(newVideos[0]);
    }

    const processedMedia: AttachedMedia[] = [];
    for (const file of filesToAdd) {
      const isVideo = isVideoFile(file) && !isImageFile(file);
      if (isVideo) {
        if (file.size > 25 * 1024 * 1024) {
          setUploadError(`Video "${file.name}" is larger than 25MB. Please pick a smaller video.`);
          continue;
        }
        const previewUrl = URL.createObjectURL(file);
        const extracted = await prepareVideoAttachment(file, previewUrl);
        const base64Data = file.size <= 3_500_000 ? await fileToBase64(file) : '';
        processedMedia.push({
          id: `${file.name}-${Date.now()}-${Math.random()}`,
          file,
          name: file.name,
          mimeType: file.type || 'video/mp4',
          type: 'video',
          previewUrl,
          base64Data,
          frames: extracted.frames,
          durationSec: extracted.durationSec,
        });
      } else {
        try {
          const prepared = await prepareImageAttachment(file);
          processedMedia.push({
            id: `${file.name}-${Date.now()}-${Math.random()}`,
            file,
            name: file.name,
            mimeType: prepared.mimeType,
            type: 'image',
            previewUrl: prepared.previewUrl,
            base64Data: prepared.base64Data,
            aspectRatio: prepared.aspectRatio,
          });
        } catch (_imgErr) {
          setUploadError(`Could not read "${file.name}". Please try another photo.`);
        }
      }
    }

    if (processedMedia.length > 0) {
      setAttachedFiles(prev => [...prev, ...processedMedia]);
    }
  };

  const removeAttachedFile = (id: string) => {
    setAttachedFiles(prev => {
      const target = prev.find(item => item.id === id);
      if (target?.previewUrl && target.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter(item => item.id !== id);
    });
  };

  const discardRecordedVoice = () => {
    setRecordedVoice((prev) => {
      if (prev?.blobUrl) {
        URL.revokeObjectURL(prev.blobUrl);
      }
      return null;
    });
  };

  // Voice recording (max 5 minutes = 300 seconds)
  const stopRecording = (discard: boolean = false) => {
    discardRecordingRef.current = discard;
    setIsRecording(false);

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch (_e) {}
      speechRecognitionRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (_e) {}
    }

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }
  };

  const startRecording = async () => {
    if (!currentUser) {
      setShowLoginModal(true);
      return;
    }
    setMicError(null);
    discardRecordedVoice();
    discardRecordingRef.current = false;
    speechTranscriptRef.current = '';
    audioChunksRef.current = [];
    recordingSecondsRef.current = 0;
    setRecordingSeconds(0);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMicError('Voice recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioStreamRef.current = stream;

      // Capture live browser speech recognition transcript alongside audio blob as an automatic backup
      try {
        const SpeechRecCtor =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (typeof SpeechRecCtor === 'function') {
          const rec = new SpeechRecCtor();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = navigator.language || 'en-US';
          let finalizedText = '';
          rec.onresult = (event: any) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const transcriptPiece = event.results[i]?.[0]?.transcript || '';
              if (event.results[i].isFinal) {
                finalizedText = `${finalizedText} ${transcriptPiece}`.trim();
              } else {
                interim = `${interim} ${transcriptPiece}`.trim();
              }
            }
            const combined = `${finalizedText} ${interim}`.trim();
            if (combined) {
              speechTranscriptRef.current = combined;
            }
          };
          rec.onerror = () => {};
          rec.start();
          speechRecognitionRef.current = rec;
        }
      } catch {
        // Browser speech recognition optional backup
      }

      const candidateMimes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const preferredMime = candidateMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = preferredMime
          ? new MediaRecorder(stream, { mimeType: preferredMime, audioBitsPerSecond: 48000 })
          : new MediaRecorder(stream, { audioBitsPerSecond: 48000 });
      } catch (_optErr) {
        mediaRecorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (discardRecordingRef.current || audioChunksRef.current.length === 0) {
          audioChunksRef.current = [];
          return;
        }

        const rawMime = mediaRecorder.mimeType || preferredMime || 'audio/webm';
        const cleanMime = rawMime.split(';')[0] || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: rawMime });
        audioChunksRef.current = [];

        if (audioBlob.size === 0) return;

        const capturedDuration = Math.min(
          MAX_VOICE_SECONDS,
          Math.max(1, recordingSecondsRef.current)
        );
        const blobUrl = URL.createObjectURL(audioBlob);
        const capturedHint = speechTranscriptRef.current.trim();

        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUri = typeof reader.result === 'string' ? reader.result : '';
          const base64Data = dataUri.split(',')[1] || '';
          setRecordedVoice({
            id: `voice_${Date.now()}`,
            blobUrl,
            dataUri,
            base64Data,
            mimeType: cleanMime,
            durationSeconds: capturedDuration,
            speechTranscript: capturedHint || undefined,
          });
        };
        reader.readAsDataURL(audioBlob);
      };

      mediaRecorder.start(250);
      setIsRecording(true);

      timerIntervalRef.current = setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);

        if (recordingSecondsRef.current >= MAX_VOICE_SECONDS) {
          stopRecording(false);
        }
      }, 1000);
    } catch (err: any) {
      console.warn('getUserMedia error:', err);
      setMicError(
        'Microphone permission is blocked. Please allow microphone access in your browser address bar to record voice.'
      );
    }
  };

  const toggleMic = () => {
    if (isRecording) {
      stopRecording(false);
    } else {
      startRecording();
    }
  };

  const handleLogout = async () => {
    if (isRecording) stopRecording(true);
    discardRecordedVoice();
    try {
      await logOutFromFirebase();
    } catch (_e) {}
    localStorage.removeItem('gutiai_user_session');
    activeScopeRef.current = null;
    sessionsRef.current = [];
    setCurrentUser(null);
    setTokenAllowance(null);
    setSessions([]);
    setMessages([]);
    setActiveSessionId(null);
    setInputText('');
    setAttachedFiles([]);
    setActivePhotoIdx(null);
    setIsThinking(false);
    setPendingMode(null);
    setVideoProgress(0);
    setIsSidebarOpen(false);
    setShowProfileModal(false);
  };

  // Helper to sync or create a session strictly scoped to the active user and persist to Firestore
  const syncSession = (sessId: string, updatedMsgs: Message[], fallbackTitle?: string) => {
    const scope = activeScopeRef.current || getUserScopeKey(currentUser);
    if (!scope) return;

    const existingList = sessionsRef.current;
    const idx = existingList.findIndex((s) => s.id === sessId);
    let sessionToSave: ChatSession;
    let nextList: ChatSession[];

    if (idx !== -1) {
      sessionToSave = {
        ...existingList[idx],
        userId: scope,
        messages: updatedMsgs,
        updatedAt: Date.now(),
      };
      nextList = [...existingList];
      nextList[idx] = sessionToSave;
    } else {
      const title = (fallbackTitle || 'New chat').trim().slice(0, 100) || 'New chat';
      sessionToSave = {
        id: sessId,
        userId: scope,
        title,
        messages: updatedMsgs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        chatMode,
      };
      nextList = [sessionToSave, ...existingList];
    }

    sessionsRef.current = nextList;
    setSessions(nextList);
    saveUserSessionsToStorage(scope, nextList);

    // Save permanently to cloud Firestore database for this authenticated user only
    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid && auth.currentUser?.uid === effectiveUid) {
      saveSessionToFirestore(effectiveUid, sessionToSave).catch((err) => {
        console.warn('Could not save session to cloud database:', err);
      });
    }
  };

  const handleNewChat = () => {
    if (isRecording) stopRecording(true);
    discardRecordedVoice();
    setActiveSessionId(null);
    setMessages([]);
    setInputText('');
    setAttachedFiles([]);
    setActivePhotoIdx(null);
    setIsThinking(false);
    setPendingMode(null);
    setVideoProgress(0);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  };

  const handleSelectSession = (session: ChatSession) => {
    const scope = activeScopeRef.current || getUserScopeKey(currentUser);
    if (session.userId && scope && session.userId !== scope) {
      return;
    }
    if (isRecording) stopRecording(true);
    discardRecordedVoice();
    setActiveSessionId(session.id);
    setMessages(session.messages || []);
    if (session.chatMode) {
      const limitActive =
        currentUser?.email &&
        loadOrCreateUserAllowance(currentUser.email).usedTokens >= DAILY_TOKEN_LIMIT;
      setChatMode(limitActive ? 'chat' : session.chatMode);
    }
    setInputText('');
    setAttachedFiles([]);
    setActivePhotoIdx(null);
    setIsThinking(false);
    setPendingMode(null);
    setVideoProgress(0);
  };

  const handleRenameSession = (sessionId: string, newTitle: string) => {
    const scope = activeScopeRef.current || getUserScopeKey(currentUser);
    if (!scope) return;

    const cleanTitle = newTitle.trim().slice(0, 100);
    if (!cleanTitle) return;

    let sessionToSave: ChatSession | null = null;
    const nextList = sessionsRef.current.map((s) => {
      if (s.id === sessionId) {
        const updated: ChatSession = {
          ...s,
          userId: scope,
          title: cleanTitle,
          updatedAt: Date.now(),
        };
        sessionToSave = updated;
        return updated;
      }
      return s;
    });

    sessionsRef.current = nextList;
    setSessions(nextList);
    saveUserSessionsToStorage(scope, nextList);

    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid && auth.currentUser?.uid === effectiveUid && sessionToSave) {
      saveSessionToFirestore(effectiveUid, sessionToSave).catch(() => {});
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    const scope = activeScopeRef.current || getUserScopeKey(currentUser);
    const nextList = sessionsRef.current.filter((s) => s.id !== sessionId);
    sessionsRef.current = nextList;
    setSessions(nextList);
    if (scope) {
      saveUserSessionsToStorage(scope, nextList);
    }
    if (activeSessionId === sessionId) {
      handleNewChat();
    }

    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid && auth.currentUser?.uid === effectiveUid) {
      deleteSessionFromFirestore(effectiveUid, sessionId).catch(() => {});
    }
  };

  const handleClearAllSessions = () => {
    const scope = activeScopeRef.current || getUserScopeKey(currentUser);
    const toDelete = [...sessionsRef.current];
    sessionsRef.current = [];
    setSessions([]);
    if (scope) {
      saveUserSessionsToStorage(scope, []);
    }
    handleNewChat();

    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid && auth.currentUser?.uid === effectiveUid) {
      toDelete.forEach((s) => {
        deleteSessionFromFirestore(effectiveUid, s.id).catch(() => {});
      });
    }
  };

  // Submit Prompt / Voice to AI
  const handleSend = async () => {
    if (!currentUser) {
      setShowLoginModal(true);
      return;
    }
    if (isRecording) return;
    const text = inputText.trim();
    if (!text && attachedFiles.length === 0 && !recordedVoice) return;

    const currentAttachments = [...attachedFiles];
    const currentVoice = recordedVoice;

    const messageAttachments: MessageAttachment[] = currentAttachments.map((a) => ({
      name: a.name,
      type: a.type,
      previewUrl: a.previewUrl,
    }));

    if (currentVoice) {
      messageAttachments.push({
        name: 'Voice message',
        type: 'audio',
        previewUrl:
          currentVoice.dataUri && currentVoice.dataUri.length < 2_400_000
            ? currentVoice.dataUri
            : currentVoice.blobUrl,
        durationSeconds: currentVoice.durationSeconds,
      });
    }

    const attachedImagesForPhotoEdit = currentAttachments.filter(
      (a) => a.type === 'image' && Boolean(a.base64Data)
    );

    // If user didn't attach a new photo right now in Photo mode, check if they're explicitly asking to edit the latest photo in this chat
    let referencedPreviousPhoto: { data: string; mimeType: string; aspectRatio?: PhotoAspectRatio } | null = null;
    if (
      chatMode === 'photo' &&
      attachedImagesForPhotoEdit.length === 0 &&
      /\b(?:this|the|that|previous|last|above)\s+(?:photo|image|picture|one)\b|\b(?:edit|change|modify|replace|remove|delete|erase|add|put|turn|make|crop|rotate|flip|filter|enhance|fix|recolor|darken|brighten)\s+(?:it|the|his|her|their|my|this|that)\b|\b(?:black\s*(?:&|and)?\s*white|grayscale|greyscale|sepia|vintage|blur\s+(?:the\s+)?background)\b/i.test(
        text
      )
    ) {
      for (let mIdx = messages.length - 1; mIdx >= 0; mIdx--) {
        const prevMsg = messages[mIdx];
        if (prevMsg.generatedPhoto?.url?.startsWith('data:image/')) {
          const parts = prevMsg.generatedPhoto.url.split(',');
          const mimeMatch = parts[0].match(/:(.*?);/);
          if (parts[1]) {
            referencedPreviousPhoto = {
              data: parts[1],
              mimeType: mimeMatch?.[1] || 'image/jpeg',
              aspectRatio: prevMsg.generatedPhoto.aspectRatio,
            };
            break;
          }
        }
        const prevImgAtt = prevMsg.attachments?.find(
          (att) => att.type === 'image' && att.previewUrl?.startsWith('data:image/')
        );
        if (prevImgAtt) {
          const parts = prevImgAtt.previewUrl.split(',');
          const mimeMatch = parts[0].match(/:(.*?);/);
          if (parts[1]) {
            referencedPreviousPhoto = {
              data: parts[1],
              mimeType: mimeMatch?.[1] || 'image/jpeg',
            };
            break;
          }
        }
      }
    }

    const isPhotoEditRequest =
      chatMode === 'photo' &&
      (attachedImagesForPhotoEdit.length > 0 || referencedPreviousPhoto !== null);

    let userPrompt = text;
    if (!userPrompt && !currentVoice && currentAttachments.length > 0) {
      if (chatMode === 'photo') {
        userPrompt = 'Enhance this photo realistically with natural lighting and crisp detail';
      } else {
        userPrompt = currentAttachments.some((a) => a.type === 'video')
          ? 'Please analyze this video and explain its key content.'
          : 'Please examine and describe these photos in detail.';
      }
    }

    const displayContent = currentVoice ? text : userPrompt;

    const newHistory: Message[] = [
      ...messages,
      {
        role: 'user',
        content: displayContent,
        attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
      },
    ];

    setMessages(newHistory);
    setInputText('');
    setAttachedFiles([]);
    setRecordedVoice(null);
    setUploadError(null);
    setPendingMode(chatMode);
    if (chatMode === 'photo') {
      const initialAspect =
        attachedImagesForPhotoEdit[0]?.aspectRatio ||
        referencedPreviousPhoto?.aspectRatio ||
        genSettings.photoAspectRatio;
      setPendingPhotoAspect(initialAspect);
      setThinkingLabel(isPhotoEditRequest ? 'Editing your image' : 'Creating your image');
    } else if (chatMode === 'video') {
      const targetDur: VideoDuration = genSettings.videoDuration === 5 ? 5 : 10;
      setPendingVideoAspect(genSettings.videoAspectRatio);
      setThinkingLabel(`Generating ${targetDur}s ${genSettings.videoQuality} video...`);
      videoProgressFloorRef.current = 1;
      videoTickCountRef.current = 0;
      setVideoProgress(1);
    } else {
      setThinkingLabel('Thinking...');
    }
    setIsThinking(true);

    // Track or create session ID
    const wasNewSession = !activeSessionId;
    let currentSessionId = activeSessionId;
    if (!currentSessionId) {
      currentSessionId = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      setActiveSessionId(currentSessionId);
      const title =
        (text || (currentVoice ? 'Voice message' : userPrompt)).trim().slice(0, 36) ||
        (chatMode === 'photo' ? 'Generated Photo' : chatMode === 'video' ? 'Video Project' : 'New chat');
      syncSession(currentSessionId, newHistory, title);
    } else {
      syncSession(currentSessionId, newHistory);
    }

    // Enforce 100k token limit on Photo & Video generation while keeping AI Chat unlimited
    if ((chatMode === 'photo' || chatMode === 'video') && currentUser?.email) {
      const freshAllowance = loadOrCreateUserAllowance(currentUser.email);
      setTokenAllowance(freshAllowance);
      if (freshAllowance.usedTokens >= DAILY_TOKEN_LIMIT) {
        const waitText = formatResetCountdown(freshAllowance.resetAt, Date.now());
        const limitHistory: Message[] = [
          ...newHistory,
          {
            role: 'assistant',
            content: `You've reached your **100k/100k** daily token limit (resets in ${waitText}). Photo and video generation are paused until reset, while **Chat** with AI remains available.`,
          },
        ];
        setMessages(limitHistory);
        syncSession(currentSessionId, limitHistory);
        setChatMode('chat');
        setIsThinking(false);
        setPendingMode(null);
        setVideoProgress(0);
        setThinkingLabel('Thinking...');
        return;
      }
    }

    // Helper for Photo / Video modes when prompt was spoken via voice recording
    const resolveSpokenPromptIfNeeded = async (): Promise<string> => {
      if (userPrompt || !currentVoice) return userPrompt;
      try {
        const res = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioData: currentVoice.base64Data,
            mimeType: currentVoice.mimeType,
            transcriptHint: currentVoice.speechTranscript,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const spoken =
            typeof data?.text === 'string' && data.text.trim()
              ? data.text.trim()
              : currentVoice.speechTranscript?.trim() || '';
          if (spoken) {
            if (wasNewSession && currentSessionId) {
              handleRenameSession(currentSessionId, spoken.slice(0, 36));
            }
            return spoken;
          }
        }
      } catch (_tErr) {}
      return currentVoice.speechTranscript?.trim() || '';
    };

    // Photo Mode: Generate new photo or edit uploaded photo -> seamless decoded reveal
    if (chatMode === 'photo') {
      setThinkingLabel(isPhotoEditRequest ? 'Editing your image' : 'Creating your image');
      try {
        const resolvedPrompt = await resolveSpokenPromptIfNeeded();
        const cleanPrompt =
          resolvedPrompt.trim() ||
          (isPhotoEditRequest
            ? 'Enhance this photo realistically with natural lighting and crisp detail'
            : 'natural candid street scene in warm afternoon sunlight');
        const selectedPhotoAspect =
          attachedImagesForPhotoEdit[0]?.aspectRatio ||
          referencedPreviousPhoto?.aspectRatio ||
          genSettings.photoAspectRatio;
        const selectedPhotoQuality = genSettings.photoQuality;

        const sourceImagePayload =
          attachedImagesForPhotoEdit.length > 0
            ? {
                data: attachedImagesForPhotoEdit[0].base64Data,
                mimeType: attachedImagesForPhotoEdit[0].mimeType,
              }
            : referencedPreviousPhoto
            ? {
                data: referencedPreviousPhoto.data,
                mimeType: referencedPreviousPhoto.mimeType,
              }
            : undefined;

        const additionalImagesPayload =
          attachedImagesForPhotoEdit.length > 1
            ? attachedImagesForPhotoEdit.slice(1, 4).map((img) => ({
                data: img.base64Data,
                mimeType: img.mimeType,
              }))
            : undefined;

        let generatedUrl: string | null = null;
        let resolvedAspect: PhotoAspectRatio = selectedPhotoAspect;
        let serverCompiledPrompt: string | undefined;
        let serverEditedPrompt: string | undefined;
        let serverHordeJobId: string | undefined;
        let serverEditStrength = 0.58;

        try {
          const response = await fetch('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: cleanPrompt,
              aspectRatio: selectedPhotoAspect,
              quality: selectedPhotoQuality,
              ...(sourceImagePayload ? { sourceImage: sourceImagePayload } : {}),
              ...(additionalImagesPayload ? { additionalImages: additionalImagesPayload } : {}),
            }),
            signal: AbortSignal.timeout(isPhotoEditRequest ? 65000 : 35000),
          });

          if (response.ok) {
            const data = await response.json();
            if (
              data?.aspectRatio === '1:1' ||
              data?.aspectRatio === '16:9' ||
              data?.aspectRatio === '9:16' ||
              data?.aspectRatio === '4:3' ||
              data?.aspectRatio === '3:4'
            ) {
              resolvedAspect = data.aspectRatio;
            }
            if (typeof data?.compiledPrompt === 'string' && data.compiledPrompt) {
              serverCompiledPrompt = data.compiledPrompt;
            }
            if (typeof data?.editedPrompt === 'string' && data.editedPrompt) {
              serverEditedPrompt = data.editedPrompt;
            }
            if (typeof data?.hordeJobId === 'string' && data.hordeJobId) {
              serverHordeJobId = data.hordeJobId;
            }

            const imageUrl = data?.imageUrl;
            if (imageUrl && imageUrl.startsWith('data:image/')) {
              await preloadImage(imageUrl, 5000);
              generatedUrl = imageUrl;
            } else if (imageUrl && imageUrl.startsWith('http')) {
              const isLoaded = await preloadImage(imageUrl);
              if (isLoaded) {
                generatedUrl = imageUrl;
              }
            } else if (data?.filterPlan && sourceImagePayload) {
              const filteredUrl = await applyCanvasPhotoFilterPlan(
                sourceImagePayload.data,
                sourceImagePayload.mimeType,
                data.filterPlan,
                resolvedAspect,
                selectedPhotoQuality
              );
              if (filteredUrl) {
                await preloadImage(filteredUrl, 4000);
                generatedUrl = filteredUrl;
              }
            }
          }
        } catch {
          // Server endpoint timed out or errored on Vercel; seamlessly hand off to browser direct failover below
        }

        // Browser-side async failover (bypasses Vercel 10s/60s timeouts and shared AWS IP ZeroGPU limits)
        if (!generatedUrl) {
          if (isPhotoEditRequest && sourceImagePayload) {
            if (serverHordeJobId) {
              generatedUrl = await pollAiHordeImageInBrowser(serverHordeJobId, 48000);
            }
            if (!generatedUrl) {
              generatedUrl = await editPhotoDirectlyInBrowser(
                sourceImagePayload.data,
                cleanPrompt,
                resolvedAspect,
                serverEditedPrompt,
                serverEditStrength
              );
            }
          } else {
            const racers: Array<Promise<string>> = [
              generatePhotoDirectlyInBrowser(
                cleanPrompt,
                resolvedAspect,
                selectedPhotoQuality,
                serverCompiledPrompt
              ).then((u) => {
                if (!u) throw new Error('direct_empty');
                return u;
              }),
            ];
            if (serverHordeJobId) {
              racers.push(
                pollAiHordeImageInBrowser(serverHordeJobId, 48000).then((u) => {
                  if (!u) throw new Error('horde_poll_empty');
                  return u;
                })
              );
            }
            try {
              generatedUrl = await Promise.any(racers);
            } catch {
              generatedUrl = null;
            }
          }
          if (generatedUrl) {
            await preloadImage(generatedUrl, 6000);
          }
        }

        if (generatedUrl) {
          recordTokenUsage(PHOTO_TOKEN_COST);
          const finalHistory: Message[] = [
            ...newHistory,
            {
              role: 'assistant',
              content: '',
              generatedPhoto: {
                url: generatedUrl,
                prompt: cleanPrompt,
                aspectRatio: resolvedAspect,
                quality: selectedPhotoQuality,
              },
            },
          ];
          setMessages(finalHistory);
          syncSession(currentSessionId, finalHistory);
          return;
        }

        const fallbackHistory: Message[] = [
          ...newHistory,
          {
            role: 'assistant',
            content: isPhotoEditRequest
              ? 'Photo editing took longer than expected. Please try again in a few moments.'
              : 'Image generation took longer than expected. Please try again in a few moments.',
          },
        ];
        setMessages(fallbackHistory);
        syncSession(currentSessionId, fallbackHistory);
      } catch (_err: any) {
        const errHistory: Message[] = [
          ...newHistory,
          {
            role: 'assistant',
            content: isPhotoEditRequest
              ? 'Photo editing took longer than expected. Please try again in a few moments.'
              : 'Image generation took longer than expected. Please try again in a few moments.',
          },
        ];
        setMessages(errHistory);
        syncSession(currentSessionId, errHistory);
      } finally {
        setIsThinking(false);
        setPendingMode(null);
        setThinkingLabel('Thinking...');
      }
      return;
    }

    // Video Mode: Smooth, lag-free realistic 5s or 10s Wan 2.2 Text-to-Video with continuous live % progress
    if (chatMode === 'video') {
      const selectedDuration: VideoDuration = genSettings.videoDuration === 5 ? 5 : 10;
      const selectedAspect = genSettings.videoAspectRatio;
      const selectedQuality = genSettings.videoQuality;
      setThinkingLabel(`Generating ${selectedDuration}s ${selectedQuality} video...`);
      const advanceVideoFloor = (floor: number) => {
        const clampedFloor = Math.max(1, Math.min(99, Math.round(floor)));
        if (clampedFloor > videoProgressFloorRef.current) {
          videoProgressFloorRef.current = clampedFloor;
        }
      };

      try {
        advanceVideoFloor(2);
        const resolvedPrompt = await resolveSpokenPromptIfNeeded();
        let cleanPrompt = resolvedPrompt
          .replace(
            /^(please\s+)?(generate|create|make|render)\s+(a\s+|an\s+)?(\d+\s*(?:-|\s)?(?:second|seconds|sec|s)\s+)?(video|clip|animation)\s*(?:of|about|showing|with)?\s*/i,
            ''
          )
          .trim();
        if (!cleanPrompt) {
          cleanPrompt =
            'ocean waves rolling onto a golden sandy coastline at sunset with seabirds gliding across the sky';
        }

        const framingText =
          selectedAspect === '9:16'
            ? `Cinematic real-world ${selectedDuration}-second vertical 9:16 live-action video of`
            : selectedAspect === '1:1'
            ? `Cinematic real-world ${selectedDuration}-second 1:1 live-action video of`
            : `Cinematic real-world ${selectedDuration}-second 16:9 widescreen live-action video of`;
        const qualityCue =
          selectedQuality === '1080p'
            ? 'ultra-crisp 1080p full HD cinema clarity'
            : selectedQuality === '480p'
            ? 'clean 480p cinema clarity'
            : 'crisp 720p HD cinema clarity';
        const wanPrompt = `${framingText} ${cleanPrompt}, fluid natural 3D motion across the full ${selectedDuration}-second sequence, continuous smooth movement, realistic physics, authentic 35mm cinema lighting, ${qualityCue}, sharp optical focus.`;
        const wanNeg =
          'static, blurred details, subtitles, paintings, still picture, worst quality, low quality, ugly, deformed, camera zoom, ken burns effect, watermark, text, signature';

        let finalVideoUrl: string | null = null;
        let serverMastered = false;

        // Fetch raw clip URL from a Gradio Space via SSE (safe to race in parallel; mastering happens only on winner)
        const fetchRawSpaceVideo = async (
          spaceBase: string,
          endpoint: string,
          payloadData: unknown[],
          sseStartPct: number,
          sseEndPct: number,
          hardTimeoutMs: number = 32000
        ): Promise<{ rawUrl: string | null; quotaExceeded: boolean }> => {
          try {
            const postRes = await fetch(`${spaceBase}/gradio_api/call${endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: payloadData }),
              signal: AbortSignal.timeout(10000),
            });
            if (!postRes.ok) {
              const errBody = await postRes.text().catch(() => '');
              return {
                rawUrl: null,
                quotaExceeded: /ZeroGPU quota|exceeded your.*quota/i.test(errBody),
              };
            }
            const postJson = await postRes.json();
            const eventId = postJson?.event_id;
            if (!eventId) return { rawUrl: null, quotaExceeded: false };

            const sseCtrl = new AbortController();
            const sseHardTimeout = setTimeout(() => sseCtrl.abort(), hardTimeoutMs);
            let sawActiveProgress = false;
            const initialActivityTimeout = setTimeout(() => {
              if (!sawActiveProgress) sseCtrl.abort();
            }, 18000);

            const sseRes = await fetch(`${spaceBase}/gradio_api/call${endpoint}/${eventId}`, {
              signal: sseCtrl.signal,
            });
            if (!sseRes.ok || !sseRes.body) {
              clearTimeout(sseHardTimeout);
              clearTimeout(initialActivityTimeout);
              return { rawUrl: null, quotaExceeded: false };
            }

            const reader = sseRes.body.getReader();
            const decoder = new TextDecoder();
            let sseText = '';
            let stepRatio = 0.06;

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                sseText += chunk;
                if (
                  chunk.includes('"index"') ||
                  chunk.includes('generating') ||
                  chunk.includes('heartbeat') ||
                  chunk.includes('event: complete')
                ) {
                  sawActiveProgress = true;
                }

                const idxMatch = chunk.match(/"index":\s*(\d+)\s*,\s*"length":\s*(\d+)/);
                if (idxMatch) {
                  const stepIdx = Number(idxMatch[1]);
                  const stepLen = Math.max(1, Number(idxMatch[2]));
                  stepRatio = Math.max(stepRatio, Math.min(0.97, (stepIdx + 1) / stepLen));
                  const mapped = Math.round(sseStartPct + stepRatio * (sseEndPct - sseStartPct));
                  advanceVideoFloor(mapped);
                } else if (chunk.includes('heartbeat') || chunk.includes('generating')) {
                  stepRatio = Math.min(0.92, stepRatio + 0.08);
                  const mapped = Math.round(sseStartPct + stepRatio * (sseEndPct - sseStartPct));
                  advanceVideoFloor(mapped);
                }

                if (sseText.includes('event: error')) {
                  try {
                    await reader.cancel();
                  } catch {}
                  return {
                    rawUrl: null,
                    quotaExceeded: /ZeroGPU quota|exceeded your.*quota/i.test(sseText),
                  };
                }
              }
            } finally {
              clearTimeout(sseHardTimeout);
              clearTimeout(initialActivityTimeout);
            }

            const urlMatch = sseText.match(/"url":\s*"([^"]+\.(?:mp4|webm|mov)[^"]*)"/i);
            const pathMatch = sseText.match(/"path":\s*"([^"]+\.(?:mp4|webm|mov))"/i);
            const rawVideoUrl = urlMatch?.[1]
              ? urlMatch[1].startsWith('http')
                ? urlMatch[1]
                : `${spaceBase}/gradio_api/file=${urlMatch[1]}`
              : pathMatch?.[1]
              ? `${spaceBase}/gradio_api/file=${pathMatch[1]}`
              : null;

            return {
              rawUrl: rawVideoUrl,
              quotaExceeded: !rawVideoUrl && /ZeroGPU quota|exceeded your.*quota/i.test(sseText),
            };
          } catch {
            return { rawUrl: null, quotaExceeded: false };
          }
        };

        const masterWinningRawVideo = async (
          rawVideoUrl: string
        ): Promise<{ url: string; mastered: boolean }> => {
          try {
            advanceVideoFloor(82);
            const masterRes = await fetch('/api/master-wan-video', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                rawVideoUrl,
                duration: selectedDuration,
                aspectRatio: selectedAspect,
                quality: selectedQuality,
              }),
              signal: AbortSignal.timeout(12000),
            });
            if (!masterRes.ok) return { url: rawVideoUrl, mastered: false };
            const masterJson = await masterRes.json();
            if (masterJson?.videoUrl) {
              return {
                url: masterJson.videoUrl,
                mastered: Boolean(masterJson?.mastered),
              };
            }

            let masterJobId = masterJson?.jobId;
            if (!masterJobId) return { url: rawVideoUrl, mastered: false };

            for (let mPoll = 0; mPoll < 60; mPoll++) {
              await new Promise((r) => setTimeout(r, 850));
              try {
                const mStatusRes = await fetch(`/api/generate-video/status/${masterJobId}`, {
                  signal: AbortSignal.timeout(12000),
                });
                if (!mStatusRes.ok) continue;
                const mStatusJson = await mStatusRes.json();
                if (typeof mStatusJson?.nextJobId === 'string' && mStatusJson.nextJobId) {
                  masterJobId = mStatusJson.nextJobId;
                }
                if (typeof mStatusJson?.progress === 'number') {
                  advanceVideoFloor(mStatusJson.progress);
                }
                if (mStatusJson?.status === 'completed' && mStatusJson?.videoUrl) {
                  return {
                    url: mStatusJson.videoUrl,
                    mastered: Boolean(mStatusJson?.mastered),
                  };
                }
                if (mStatusJson?.status === 'failed') break;
              } catch {
                // Continue polling on transient network hiccup
              }
            }
          } catch {}
          return { url: rawVideoUrl, mastered: false };
        };

        const [w1W, w1H] =
          selectedAspect === '9:16'
            ? [480, 832]
            : selectedAspect === '1:1'
            ? [640, 640]
            : [832, 480];
        const [ltxH, ltxW] =
          selectedAspect === '9:16'
            ? [768, 512]
            : selectedAspect === '1:1'
            ? [512, 512]
            : [512, 768];
        const [ltxDistH, ltxDistW] =
          selectedAspect === '9:16'
            ? [704, 512]
            : selectedAspect === '1:1'
            ? [512, 512]
            : [512, 704];

        // 1. Server-authenticated Text-to-Video first (HF Inference Providers / Gemini Veo / fast server edge)
        try {
          const startRes = await fetch('/api/generate-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: cleanPrompt,
              duration: selectedDuration,
              aspectRatio: selectedAspect,
              quality: selectedQuality,
            }),
            signal: AbortSignal.timeout(30000),
          });

          if (startRes.ok) {
            const startData = await startRes.json();
            if (startData?.videoUrl) {
              finalVideoUrl = startData.videoUrl;
              serverMastered = Boolean(startData?.mastered);
            } else {
              let activeJobId = startData?.jobId;
              let consecutiveServerErrors = 0;
              for (let pollIdx = 0; activeJobId && !finalVideoUrl && pollIdx < 70; pollIdx++) {
                await new Promise((r) => setTimeout(r, 900));
                try {
                  const pollRes = await fetch(`/api/generate-video/status/${activeJobId}`, {
                    signal: AbortSignal.timeout(26000),
                  });
                  if (!pollRes.ok) {
                    if (pollRes.status === 404 || pollRes.status === 504) break;
                    consecutiveServerErrors += 1;
                    if (consecutiveServerErrors >= 2) break;
                    continue;
                  }
                  consecutiveServerErrors = 0;
                  const pollData = await pollRes.json();
                  if (typeof pollData?.nextJobId === 'string' && pollData.nextJobId) {
                    activeJobId = pollData.nextJobId;
                  }
                  if (typeof pollData?.progress === 'number') {
                    advanceVideoFloor(pollData.progress);
                  }
                  if (pollData?.status === 'completed' && pollData?.videoUrl) {
                    finalVideoUrl = pollData.videoUrl;
                    serverMastered = Boolean(pollData?.mastered);
                    break;
                  }
                  if (pollData?.quotaLimited || pollData?.status === 'failed') {
                    break;
                  }
                } catch {
                  consecutiveServerErrors += 1;
                  if (consecutiveServerErrors >= 2) break;
                }
              }
            }
          }
        } catch {
          // Fall back cleanly to browser-edge parallel races below
        }

        // 2. Parallel browser-edge Wave 1 & Wave 2 races across verified Text-to-Video Spaces
        if (!finalVideoUrl) {
          const upsamplerAspect =
            selectedAspect === '9:16'
              ? '9:16 (480x832)'
              : selectedAspect === '1:1'
              ? '1:1 (640x640)'
              : '16:9 (832x480)';
          const wave1Tiers: Array<{
            baseUrl: string;
            endpoint: string;
            payload: unknown[];
            startPct: number;
          }> = [
            {
              baseUrl: 'https://mediasynthesismuseum-modelscope-text-to-video.hf.space',
              endpoint: '/generate',
              payload: [wanPrompt, -1, 32, 25],
              startPct: 16,
            },
            {
              baseUrl: 'https://upsampler-ltx-2-5.hf.space',
              endpoint: '/generate_video',
              payload: [
                wanPrompt,
                null,
                selectedAspect === '9:16' ? 832 : 512,
                selectedAspect === '9:16' ? 512 : selectedAspect === '1:1' ? 512 : 832,
                5,
                42,
                'conv',
                false,
                true,
                true,
              ],
              startPct: 20,
            },
            {
              baseUrl: 'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
              endpoint: '/generate_video',
              payload: [
                wanPrompt,
                upsamplerAspect,
                4,
                wanNeg,
                4,
                1,
                1,
                Math.floor(Math.random() * 2147483647),
                true,
              ],
              startPct: 22,
            },
          ];

          const wave2Tiers: Array<{
            baseUrl: string;
            endpoint: string;
            payload: unknown[];
            startPct: number;
          }> = [
            {
              baseUrl: 'https://prithivmlmods-nava-text-to-video.hf.space',
              endpoint: '/infer_fn',
              payload: [
                wanPrompt,
                '',
                null,
                null,
                null,
                16,
                5,
                selectedAspect === '9:16'
                  ? '9:16 (704×1280)'
                  : selectedAspect === '1:1'
                  ? '1:1 (960×960)'
                  : '16:9 (1280×704)',
              ],
              startPct: 26,
            },
            {
              baseUrl: 'https://lightricks-ltx-2-5.hf.space',
              endpoint: '/run',
              payload: [
                wanPrompt,
                null,
                selectedAspect === '9:16' ? 832 : 512,
                selectedAspect === '9:16' ? 512 : selectedAspect === '1:1' ? 512 : 832,
                5,
                42,
                'conv',
                false,
                true,
                false,
              ],
              startPct: 28,
            },
            {
              baseUrl: 'https://lightricks-ltx-2-3.hf.space',
              endpoint: '/generate_video',
              payload: [
                null,
                wanPrompt,
                5,
                false,
                Math.floor(Math.random() * 2147483647),
                true,
                ltxH,
                ltxW,
              ],
              startPct: 30,
            },
            {
              baseUrl: 'https://lightricks-ltx-video-distilled.hf.space',
              endpoint: '/text_to_video',
              payload: [
                wanPrompt,
                wanNeg,
                '',
                '',
                ltxDistH,
                ltxDistW,
                'text-to-video',
                5,
                9,
                Math.floor(Math.random() * 2147483647),
                true,
                1.0,
                false,
              ],
              startPct: 34,
            },
            {
              baseUrl: 'https://numanajmal0-wan-video-api.hf.space',
              endpoint: '/generate',
              payload: ['wan-base', wanPrompt, wanNeg, w1W, w1H, 81, 18, 5, -1, 1, null],
              startPct: 36,
            },
            {
              baseUrl: 'https://alexnasa-ltx-2-turbo.hf.space',
              endpoint: '/generate_video',
              payload: [
                null,
                null,
                wanPrompt,
                null,
                'Text-to-Video',
                false,
                Math.floor(Math.random() * 2147483647),
                true,
                ltxH,
                ltxW,
                'No LoRA',
                null,
              ],
              startPct: 38,
            },
            {
              baseUrl: 'https://zai-org-cogvideox-2b-space.hf.space',
              endpoint: '/generate',
              payload: [wanPrompt, 35, 6],
              startPct: 40,
            },
            {
              baseUrl: 'https://zai-org-cogvideox-5b-space.hf.space',
              endpoint: '/generate',
              payload: [wanPrompt, null, null, 0.8, -1, false, false],
              startPct: 42,
            },
          ];

          const raceTierWave = async (
            tiers: typeof wave1Tiers,
            hardTimeoutMs: number
          ): Promise<{ rawUrl: string | null; allQuotaExceeded: boolean }> => {
            let quotaHits = 0;
            try {
              const winningRawUrl = await Promise.any(
                tiers.map(async (tier) => {
                  const res = await fetchRawSpaceVideo(
                    tier.baseUrl,
                    tier.endpoint,
                    tier.payload,
                    tier.startPct,
                    81,
                    hardTimeoutMs
                  );
                  if (res.quotaExceeded) quotaHits += 1;
                  if (!res.rawUrl) throw new Error('empty_space');
                  return res.rawUrl;
                })
              );
              return { rawUrl: winningRawUrl, allQuotaExceeded: false };
            } catch {
              return {
                rawUrl: null,
                allQuotaExceeded: quotaHits >= tiers.length,
              };
            }
          };

          const wave1Res = await raceTierWave(wave1Tiers, 28000);
          let winningRawUrl = wave1Res.rawUrl;
          if (!winningRawUrl && !wave1Res.allQuotaExceeded) {
            const wave2Res = await raceTierWave(wave2Tiers, 26000);
            winningRawUrl = wave2Res.rawUrl;
          }

          if (winningRawUrl) {
            const mastered = await masterWinningRawVideo(winningRawUrl);
            finalVideoUrl = mastered.url;
            serverMastered = mastered.mastered;
          }
        }

        // 3. Always-available non-ZeroGPU AI Multi-Keyframe Motion fallback if all remote GPU Spaces are quota-exhausted
        if (!finalVideoUrl) {
          const fallbackVideoUrl = await generateMultiKeyframeMotionVideoInBrowser(
            cleanPrompt,
            selectedDuration,
            selectedAspect,
            selectedQuality,
            advanceVideoFloor
          );
          if (fallbackVideoUrl) {
            finalVideoUrl = fallbackVideoUrl;
            serverMastered = true;
          }
        }

        if (finalVideoUrl) {
          advanceVideoFloor(86);
          const conformedBlobUrl = await conformVideoToSettingsInBrowser(
            finalVideoUrl,
            selectedDuration,
            selectedAspect,
            selectedQuality,
            serverMastered,
            (pct) => advanceVideoFloor(pct)
          );
          if (conformedBlobUrl) {
            videoBlobUrlsRef.current[finalVideoUrl] = conformedBlobUrl;
            setVideoBlobUrls((prev) => ({ ...prev, [finalVideoUrl!]: conformedBlobUrl }));
          } else {
            await preloadVideoInMemory(finalVideoUrl);
          }

          advanceVideoFloor(99);
          setVideoProgress((prev) => Math.max(prev, 99));
          videoProgressFloorRef.current = 100;
          setVideoProgress(100);
          await new Promise((r) => setTimeout(r, 180));

          recordTokenUsage(VIDEO_TOKEN_COST);
          const finalHistory: Message[] = [
            ...newHistory,
            {
              role: 'assistant',
              content: '',
              generatedVideo: {
                url: finalVideoUrl,
                prompt: cleanPrompt,
                duration: selectedDuration,
                aspectRatio: selectedAspect,
                quality: selectedQuality,
              },
            },
          ];
          setMessages(finalHistory);
          syncSession(currentSessionId, finalHistory);
          return;
        }

        const busyHistory: Message[] = [
          ...newHistory,
          {
            role: 'assistant',
            content: 'Video generation servers are currently busy. Please try again in a moment.',
          },
        ];
        setMessages(busyHistory);
        syncSession(currentSessionId, busyHistory);
      } catch (_vErr) {
        const busyHistory: Message[] = [
          ...newHistory,
          {
            role: 'assistant',
            content: 'Video generation servers are currently busy. Please try again in a moment.',
          },
        ];
        setMessages(busyHistory);
        syncSession(currentSessionId, busyHistory);
      } finally {
        setIsThinking(false);
        setPendingMode(null);
        setVideoProgress(0);
        videoProgressFloorRef.current = 0;
        videoTickCountRef.current = 0;
        setThinkingLabel('Thinking...');
      }
      return;
    }

    // Chat Mode: Chat with AI (always allowed, even after reaching 100k token limit)
    setThinkingLabel('Thinking...');
    try {
      const payloadAttachments: Array<{
        name: string;
        mimeType: string;
        data: string;
        kind?: string;
        transcriptHint?: string;
      }> = [];

      for (const a of currentAttachments) {
        if (a.type === 'video') {
          if (a.frames && a.frames.length > 0) {
            for (const frame of a.frames) {
              payloadAttachments.push({
                name: `${a.name} (${frame.timeSec.toFixed(1)}s)`,
                kind: 'video-frame',
                mimeType: frame.mimeType,
                data: frame.data,
              });
            }
          }
          if (a.base64Data && a.base64Data.length < 3_600_000) {
            payloadAttachments.push({
              name: a.name,
              mimeType: a.mimeType,
              data: a.base64Data,
            });
          }
        } else if (a.base64Data) {
          payloadAttachments.push({
            name: a.name,
            mimeType: a.mimeType,
            data: a.base64Data,
          });
        }
      }

      if (currentVoice && currentVoice.base64Data) {
        payloadAttachments.push({
          name: 'voice-message.webm',
          mimeType: currentVoice.mimeType,
          data: currentVoice.base64Data,
          ...(currentVoice.speechTranscript ? { transcriptHint: currentVoice.speechTranscript } : {}),
        });
      }

      const messagesPayload = newHistory
        .map((m) => ({
          role: m.role,
          content: (m.content || m.voiceTranscript || '').trim(),
        }))
        .filter((m, idx, arr) => m.content.length > 0 || idx === arr.length - 1)
        .slice(-8);

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: messagesPayload,
          attachments: payloadAttachments,
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned ${response.status}`);
      }
      const data: any = await response.json();
      const chatTokens =
        typeof data.tokensUsed === 'number' && data.tokensUsed > 0
          ? data.tokensUsed
          : Math.max(
              80,
              Math.ceil(
                ((userPrompt?.length || 40) + String(data.content || '').length) / 4
              )
            );
      recordTokenUsage(chatTokens);

      const updatedUserHistory = [...newHistory];
      if (data.voiceTranscript && updatedUserHistory.length > 0) {
        const lastIdx = updatedUserHistory.length - 1;
        updatedUserHistory[lastIdx] = {
          ...updatedUserHistory[lastIdx],
          voiceTranscript: data.voiceTranscript,
        };
        if (wasNewSession && !text && currentSessionId) {
          handleRenameSession(currentSessionId, String(data.voiceTranscript).trim().slice(0, 36));
        }
      }

      const finalHistory: Message[] = [
        ...updatedUserHistory,
        { role: 'assistant', content: data.content },
      ];
      setMessages(finalHistory);
      syncSession(currentSessionId, finalHistory);
    } catch (err: any) {
      console.error('AI Error:', err);
      const errorMessage = `**Request failed:** ${err.message || 'Unable to connect to AI service. Please check your network connection.'}`;
      const errHistory: Message[] = [...newHistory, { role: 'assistant', content: errorMessage }];
      setMessages(errHistory);
      syncSession(currentSessionId, errHistory);
    } finally {
      setIsThinking(false);
      setPendingMode(null);
    }
  };

  const hasContent =
    !isRecording &&
    (inputText.trim().length > 0 || attachedFiles.length > 0 || Boolean(recordedVoice));

  const effectiveAllowance: UserTokenAllowance | null = currentUser?.email
    ? tokenAllowance || loadOrCreateUserAllowance(currentUser.email)
    : null;
  const isTokenLimitReached = Boolean(
    effectiveAllowance &&
      effectiveAllowance.resetAt > nowTick &&
      effectiveAllowance.usedTokens >= DAILY_TOKEN_LIMIT
  );
  const usageRatio = effectiveAllowance
    ? Math.min(1, Math.max(0, effectiveAllowance.usedTokens / DAILY_TOKEN_LIMIT))
    : 0;
  const usagePercentSvg = Number((usageRatio * 100).toFixed(2));
  const usagePercentDisplay = Math.round(usageRatio * 100);

  // Placeholder text for the modes
  const getPlaceholderText = () => {
    if (isRecording) return 'Recording voice...';
    if (recordedVoice) return 'Add an optional message or click Run to send voice...';
    if (chatMode === 'photo') {
      return attachedFiles.some((f) => f.type === 'image')
        ? 'Describe how you want to edit this photo...'
        : 'Describe the photo you want to generate...';
    }
    if (chatMode === 'video') return 'Describe the video you want to generate...';
    return 'Ask a question...';
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="fixed left-0 right-0 top-[var(--app-offset-top,0px)] h-[var(--app-height,100dvh)] w-full text-[#e3e3e3] flex flex-col overflow-hidden bg-[#191919] overscroll-none">
      {/* Main Content — full browser width */}
      <div className="w-full flex-1 flex flex-col justify-between h-full min-h-0 relative">
          
          {/* Top Header */}
          <motion.header
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="w-full flex items-center justify-between px-4 sm:px-6 lg:px-8 pt-3.5 pb-2.5 border-b border-white/[0.06] z-30 shrink-0 bg-[#191919] touch-none"
          >
            <div className="relative flex items-center gap-2.5 sm:gap-3.5 min-w-0">
              <motion.button 
                id="toggle-sidebar-btn"
                whileTap={{ scale: 0.92 }}
                onClick={() => {
                  if (!currentUser) {
                    setShowLoginModal(true);
                    return;
                  }
                  setShowUploadMenu(false);
                  setShowModeMenu(false);
                  setIsSidebarOpen((prev) => !prev);
                }}
                className="w-8 h-8 flex items-center justify-center rounded-full neutral-btn shadow-sm cursor-pointer hover:bg-white/10 transition shrink-0"
                title={isSidebarOpen ? "Close chat history" : "Open chat history"}
              >
                <span className="material-symbols-outlined text-[19px]">menu</span>
              </motion.button>

              {/* Mini Chat History Popover */}
              <HistorySidebar
                isOpen={isSidebarOpen}
                onToggle={() => setIsSidebarOpen((prev) => !prev)}
                onClose={() => setIsSidebarOpen(false)}
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelectSession={handleSelectSession}
                onNewChat={handleNewChat}
                onRenameSession={handleRenameSession}
                onDeleteSession={handleDeleteSession}
                currentUser={currentUser}
              />

              <AnimatePresence mode="wait">
                {activeSessionId && (
                  <motion.span
                    key={activeSessionId}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={{ duration: 0.18 }}
                    className="text-[13px] text-gray-400 truncate max-w-[130px] sm:max-w-[260px] hidden md:inline"
                  >
                    {sessions.find((s) => s.id === activeSessionId)?.title || ''}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>

          {/* User Profile (when logged in) or Login Action */}
          <div className="relative flex items-center gap-2">
            {!currentUser ? (
              <motion.button
                id="open-login-btn"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowLoginModal(true)}
                className="h-8 px-3.5 neutral-btn text-[12px] font-medium rounded-full flex items-center shadow-sm cursor-pointer hover:bg-[#3e3e3e] transition"
              >
                <span>Log in</span>
              </motion.button>
            ) : (
              <motion.button
                id="user-profile-btn"
                type="button"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => {
                  setShowUploadMenu(false);
                  setShowModeMenu(false);
                  setIsSidebarOpen(false);
                  if (currentUser?.email) {
                    setNowTick(Date.now());
                    setTokenAllowance(loadOrCreateUserAllowance(currentUser.email));
                  }
                  setShowProfileModal(true);
                }}
                className="h-8 pl-1 pr-2 rounded-full bg-[#323232] hover:bg-[#3e3e3e] border border-white/10 hover:border-white/20 flex items-center gap-1.5 shadow-sm cursor-pointer transition select-none"
                title={`${currentUser.name} - View profile`}
                aria-label="View profile"
              >
                {currentUser.avatarUrl ? (
                  <img
                    src={currentUser.avatarUrl}
                    alt={currentUser.name}
                    referrerPolicy="no-referrer"
                    className="w-6 h-6 rounded-full object-cover border border-white/20"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-[#464646] to-[#323232] border border-white/20 flex items-center justify-center text-[11px] font-semibold text-white">
                    {(currentUser.name || currentUser.email || 'U').trim().charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="text-[12px] font-medium text-gray-200 truncate max-w-[80px] sm:max-w-[120px] hidden sm:inline">
                  {currentUser.name}
                </span>
              </motion.button>
            )}
          </div>
        </motion.header>

        {/* Chat Canvas */}
        <div
          id="chat-canvas"
          ref={chatCanvasRef}
          className={`flex-1 min-h-0 w-full px-4 sm:px-6 lg:px-10 py-4 flex flex-col z-10 ${
            messages.length === 0 && !isThinking
              ? 'overflow-hidden touch-none'
              : 'overflow-y-auto overscroll-y-contain touch-pan-y'
          }`}
        >
          {messages.length === 0 && !isThinking ? (
            <motion.div
              key={currentScope || 'guest'}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
              className="flex-1 min-h-0 flex flex-col items-center justify-center text-center px-4 select-none my-auto relative w-full max-w-5xl mx-auto touch-none"
              id="empty-state"
            >
              <div className="relative mb-5 flex items-center justify-center">
                <div
                  className="absolute w-24 h-24 rounded-full bg-gradient-to-tr from-sky-500/20 via-emerald-400/15 to-fuchsia-500/20 blur-xl ambient-aura pointer-events-none"
                  aria-hidden="true"
                />
                <img
                  src="/logo-icon.svg"
                  alt="BloopX Emblem"
                  className="w-12 h-12 sm:w-14 sm:h-14 object-contain relative z-10 ambient-float drop-shadow-lg"
                />
              </div>
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08, duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
                className="text-3xl sm:text-5xl md:text-6xl font-semibold text-[#e3e3e3] tracking-tight leading-tight max-w-4xl drop-shadow-sm"
              >
                What would you like to explore today?
              </motion.h1>
            </motion.div>
          ) : (
            <div className="space-y-5 w-full max-w-6xl mx-auto flex-1">
              <AnimatePresence initial={false}>
              {messages.map((msg, idx) => (
                <motion.div
                  key={`${activeSessionId || 'active'}-${idx}`}
                  initial={{
                    opacity: 0,
                    y: 12,
                    scale: msg.role === 'user' ? 0.97 : 0.99,
                  }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} w-full`}
                >
                  {msg.role === 'user' ? (
                    <div className="max-w-[85%] sm:max-w-[75%] flex flex-col items-end">
                      <div
                        className="w-full bg-[#2a2a2a] text-white px-4 py-2.5 rounded-2xl text-[14.5px] leading-relaxed break-words border border-white/[0.08] space-y-2.5 shadow-sm"
                      >
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="flex flex-wrap gap-2 pt-0.5 pb-0.5">
                            {msg.attachments.map((att, aIdx) =>
                              att.type === 'audio' ? (
                                <VoiceAudioPlayer
                                  key={aIdx}
                                  src={att.previewUrl}
                                  durationSeconds={att.durationSeconds}
                                />
                              ) : (
                                <div key={aIdx} className="relative rounded-xl overflow-hidden border border-white/10 bg-black/40">
                                  {att.type === 'image' ? (
                                    <img 
                                      src={att.previewUrl} 
                                      alt={att.name} 
                                      className="w-24 h-24 sm:w-28 sm:h-28 object-cover" 
                                    />
                                  ) : (
                                    <div className="w-40 h-28 flex flex-col items-center justify-center bg-[#202020] p-2 text-center">
                                      <span className="material-symbols-outlined text-3xl text-emerald-400 mb-1">videocam</span>
                                      <span className="text-[11px] text-gray-300 truncate max-w-[130px]">{att.name}</span>
                                    </div>
                                  )}
                                </div>
                              )
                            )}
                          </div>
                        )}
                        {msg.content && (
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-full w-full ai-output text-[#e3e3e3] px-2 py-1 text-[14.5px]">
                      {msg.generatedVideo ? (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                          className={`w-full ${
                            msg.generatedVideo.aspectRatio === '9:16'
                              ? 'max-w-[300px]'
                              : msg.generatedVideo.aspectRatio === '1:1'
                              ? 'max-w-lg'
                              : 'max-w-2xl'
                          }`}
                        >
                          <div className="rounded-[24px] overflow-hidden border border-white/[0.08] bg-[#252525] shadow-2xl group">
                            <div
                              className={`relative overflow-hidden bg-black flex items-center justify-center ${
                                msg.generatedVideo.aspectRatio === '9:16'
                                  ? 'aspect-[9/16]'
                                  : msg.generatedVideo.aspectRatio === '1:1'
                                  ? 'aspect-square'
                                  : 'aspect-video'
                              }`}
                            >
                              <video
                                src={videoBlobUrls[msg.generatedVideo.url] || msg.generatedVideo.url}
                                controls
                                muted
                                playsInline
                                autoPlay
                                preload="auto"
                                className="w-full h-full object-cover bg-black"
                              />

                              {/* Download Icon on Top-Right / Hover */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadVideo(msg.generatedVideo!.url, `video-${idx + 1}.mp4`);
                                }}
                                className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/85 hover:bg-black text-white flex items-center justify-center shadow-lg transition-all duration-200 cursor-pointer z-20 outline-none opacity-0 group-hover:opacity-100 scale-95 group-hover:scale-100"
                                title="Download video"
                              >
                                <span className="material-symbols-outlined text-[19px]">download</span>
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      ) : msg.generatedPhoto ? (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                          className={`w-full ${
                            msg.generatedPhoto.aspectRatio === '9:16'
                              ? 'max-w-[300px]'
                              : msg.generatedPhoto.aspectRatio === '3:4'
                              ? 'max-w-[360px]'
                              : msg.generatedPhoto.aspectRatio === '16:9'
                              ? 'max-w-2xl'
                              : 'max-w-lg'
                          }`}
                        >
                          <div className="rounded-[24px] overflow-hidden border border-white/[0.08] bg-[#252525] shadow-xl">
                            <div
                              className={`relative overflow-hidden bg-[#1e1e1e] flex items-center justify-center cursor-pointer group select-none ${
                                msg.generatedPhoto.aspectRatio === '9:16'
                                  ? 'aspect-[9/16]'
                                  : msg.generatedPhoto.aspectRatio === '3:4'
                                  ? 'aspect-[3/4]'
                                  : msg.generatedPhoto.aspectRatio === '4:3'
                                  ? 'aspect-[4/3]'
                                  : msg.generatedPhoto.aspectRatio === '16:9'
                                  ? 'aspect-video'
                                  : 'aspect-square'
                              }`}
                              onClick={() => {
                                setActivePhotoIdx((prev) => (prev === idx ? null : idx));
                              }}
                            >
                              <img
                                src={msg.generatedPhoto.url}
                                alt={msg.generatedPhoto.prompt || 'Photo'}
                                className="w-full h-full object-cover select-none pointer-events-none transition-transform duration-300 group-hover:scale-[1.015]"
                                loading="eager"
                                decoding="sync"
                              />

                              {/* Download Icon on Under-Right Side */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadImage(msg.generatedPhoto!.url, `photo-${idx + 1}.jpg`);
                                }}
                                className={`absolute bottom-3 right-3 w-9 h-9 rounded-full bg-black/85 hover:bg-black text-white flex items-center justify-center shadow-lg transition-all duration-200 cursor-pointer z-20 outline-none ${
                                  activePhotoIdx === idx
                                    ? 'opacity-100 scale-100'
                                    : 'opacity-0 group-hover:opacity-100 scale-95 group-hover:scale-100'
                                }`}
                                title="Download image"
                              >
                                <span className="material-symbols-outlined text-[19px]">download</span>
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      ) : (
                        /* Sanitized Markdown Text Response for chat */
                        <div dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(msg.content) }} />
                      )}
                    </div>
                  )}
                </motion.div>
              ))}
              </AnimatePresence>

              <AnimatePresence>
              {isThinking && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="flex justify-start w-full px-2 py-1"
                >
                  {pendingMode === 'photo' ? (
                    <div
                      id="photo-creation-placeholder"
                      className={`w-full select-none ${
                        pendingPhotoAspect === '9:16'
                          ? 'max-w-[300px]'
                          : pendingPhotoAspect === '3:4'
                          ? 'max-w-[360px]'
                          : pendingPhotoAspect === '16:9'
                          ? 'max-w-2xl'
                          : 'max-w-lg'
                      }`}
                    >
                      <div className="mb-3 flex items-center gap-2.5 px-0.5">
                        <svg
                          viewBox="0 0 24 24"
                          className="w-[18px] h-[18px] text-[#e3e3e3] creation-sparkle shrink-0"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M10.5 3.5C10.9 7.2 12.8 9.1 16.5 9.5C12.8 9.9 10.9 11.8 10.5 15.5C10.1 11.8 8.2 9.9 4.5 9.5C8.2 9.1 10.1 7.2 10.5 3.5Z" />
                          <path d="M18 13.5C18.25 15.6 19.4 16.75 21.5 17C19.4 17.25 18.25 18.4 18 20.5C17.75 18.4 16.6 17.25 14.5 17C16.6 16.75 17.75 15.6 18 13.5Z" />
                        </svg>
                        <span className="thinking-shimmer text-[14.5px] font-normal tracking-tight">
                          {thinkingLabel || 'Creating your image'}
                        </span>
                      </div>

                      <div
                        className={`w-full rounded-[24px] media-creation-surface border border-white/[0.06] shadow-2xl ${
                          pendingPhotoAspect === '9:16'
                            ? 'aspect-[9/16]'
                            : pendingPhotoAspect === '3:4'
                            ? 'aspect-[3/4]'
                            : pendingPhotoAspect === '4:3'
                            ? 'aspect-[4/3]'
                            : pendingPhotoAspect === '16:9'
                            ? 'aspect-video'
                            : 'aspect-square'
                        }`}
                      />
                    </div>
                  ) : pendingMode === 'video' ? (
                    <div
                      id="video-creation-placeholder"
                      className={`w-full select-none ${
                        pendingVideoAspect === '9:16'
                          ? 'max-w-[300px]'
                          : pendingVideoAspect === '1:1'
                          ? 'max-w-lg'
                          : 'max-w-2xl'
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3 px-0.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <svg
                            viewBox="0 0 24 24"
                            className="w-[18px] h-[18px] text-[#e3e3e3] creation-sparkle shrink-0"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path d="M10.5 3.5C10.9 7.2 12.8 9.1 16.5 9.5C12.8 9.9 10.9 11.8 10.5 15.5C10.1 11.8 8.2 9.9 4.5 9.5C8.2 9.1 10.1 7.2 10.5 3.5Z" />
                            <path d="M18 13.5C18.25 15.6 19.4 16.75 21.5 17C19.4 17.25 18.25 18.4 18 20.5C17.75 18.4 16.6 17.25 14.5 17C16.6 16.75 17.75 15.6 18 13.5Z" />
                          </svg>
                          <span className="thinking-shimmer text-[14.5px] font-normal tracking-tight">
                            {thinkingLabel}
                          </span>
                        </div>
                        <span className="text-[13px] font-medium text-[#e3e3e3] tabular-nums shrink-0">
                          {videoProgress}%
                        </span>
                      </div>

                      <div
                        className={`w-full rounded-[24px] media-creation-surface border border-white/[0.06] shadow-2xl relative overflow-hidden flex flex-col items-center justify-center ${
                          pendingVideoAspect === '9:16'
                            ? 'aspect-[9/16]'
                            : pendingVideoAspect === '1:1'
                            ? 'aspect-square'
                            : 'aspect-video'
                        }`}
                      >
                        <div className="relative w-16 h-16 flex items-center justify-center">
                          <svg
                            viewBox="0 0 64 64"
                            className="w-full h-full -rotate-90"
                            aria-hidden="true"
                          >
                            <circle
                              cx="32"
                              cy="32"
                              r="27"
                              fill="none"
                              stroke="rgba(255,255,255,0.09)"
                              strokeWidth="3.2"
                            />
                            <circle
                              cx="32"
                              cy="32"
                              r="27"
                              fill="none"
                              stroke="#e3e3e3"
                              strokeWidth="3.2"
                              strokeLinecap="round"
                              strokeDasharray={169.65}
                              strokeDashoffset={Number(
                                (169.65 * (1 - Math.min(100, Math.max(0, videoProgress)) / 100)).toFixed(2)
                              )}
                              className="transition-all duration-300 ease-out"
                            />
                          </svg>
                          <span className="absolute text-[13.5px] font-semibold text-white tabular-nums tracking-tight">
                            {videoProgress}%
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2.5">
                      <div className="flex items-center gap-1" aria-hidden="true">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 thinking-dot [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 thinking-dot [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 thinking-dot [animation-delay:300ms]" />
                      </div>
                      <span className="thinking-shimmer text-[14px] font-medium">{thinkingLabel}</span>
                    </div>
                  )}
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* Hidden Native File Inputs */}
        <input 
          type="file" 
          id="media-file-input" 
          ref={mediaFileInputRef}
          accept="image/*,video/*" 
          multiple 
          className="hidden" 
          onChange={(e) => {
            if (e.target.files) handleFilesSelect(e.target.files);
            e.target.value = '';
          }}
        />
        <input 
          type="file" 
          id="doc-file-input" 
          ref={docFileInputRef}
          accept="image/*,video/*" 
          multiple 
          className="hidden" 
          onChange={(e) => {
            if (e.target.files) handleFilesSelect(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Prompt Input Container */}
        <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6 sm:pb-5 lg:px-10 z-20 w-full relative shrink-0 bg-[#191919] touch-none">
          <div className="w-full max-w-6xl mx-auto relative">

          {/* Upload Validation Alert */}
          {uploadError && (
            <div className="mb-2.5 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-200 text-[12px] rounded-xl flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-red-400">error</span>
                <span>{uploadError}</span>
              </div>
              <button 
                onClick={() => setUploadError(null)}
                className="text-red-300 hover:text-white text-[11px] underline cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Microphone Permission Alert */}
          {micError && (
            <div className="mb-2.5 px-3 py-2 bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[12px] rounded-xl flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-amber-400">mic_off</span>
                <span>{micError}</span>
              </div>
              <button 
                onClick={() => setMicError(null)}
                className="text-amber-300 hover:text-white text-[11px] underline cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}
          
          {/* Upload Menu */}
          <AnimatePresence>
          {showUploadMenu && (
            <motion.div 
              id="upload-menu" 
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="absolute left-0 bottom-16 sm:bottom-20 bg-[#252525] rounded-2xl p-1.5 shadow-2xl z-30 w-52 border border-white/10 origin-bottom-left"
            >
              <button 
                id="upload-media-btn" 
                onClick={() => {
                  mediaFileInputRef.current?.click();
                  setShowUploadMenu(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#e3e3e3] hover:bg-white/5 rounded-xl transition text-left cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] text-[#9e9e9e]">perm_media</span>
                <span>Photos & Videos</span>
              </button>
              <button 
                id="upload-doc-btn" 
                onClick={() => {
                  docFileInputRef.current?.click();
                  setShowUploadMenu(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#e3e3e3] hover:bg-white/5 rounded-xl transition text-left cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] text-[#9e9e9e]">upload_file</span>
                <span>Upload files</span>
              </button>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Mode Selector Menu (3 Options: Chat, Photo, Video) */}
          <AnimatePresence>
          {showModeMenu && (
            <motion.div 
              id="mode-menu" 
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="absolute left-10 bottom-16 sm:bottom-20 bg-[#252525] rounded-2xl p-1.5 shadow-2xl z-30 w-48 border border-white/10 origin-bottom-left"
            >
              {/* Option 1: Chat mode */}
              <button 
                onClick={() => {
                  setChatMode('chat');
                  setShowModeMenu(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-[12.5px] rounded-xl transition text-left cursor-pointer ${
                  chatMode === 'chat' ? 'bg-white/10 text-white font-medium' : 'text-[#d4d4d4] hover:bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[18px] text-blue-400">chat_bubble</span>
                  <div>
                    <p className="leading-tight">Chat</p>
                    <p className="text-[10.5px] text-[#8e8e8e]">Chat with AI</p>
                  </div>
                </div>
                {chatMode === 'chat' && (
                  <span className="material-symbols-outlined text-[16px] text-blue-400">check</span>
                )}
              </button>

              {/* Option 2: Photo mode */}
              <button 
                disabled={isTokenLimitReached}
                onClick={() => {
                  if (isTokenLimitReached) return;
                  setChatMode('photo');
                  setShowModeMenu(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-[12.5px] rounded-xl transition text-left ${
                  isTokenLimitReached
                    ? 'opacity-45 cursor-not-allowed text-[#9e9e9e]'
                    : chatMode === 'photo'
                    ? 'bg-white/10 text-white font-medium cursor-pointer'
                    : 'text-[#d4d4d4] hover:bg-white/5 cursor-pointer'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[18px] text-emerald-400">image</span>
                  <div>
                    <p className="leading-tight">Photo</p>
                    <p className="text-[10.5px] text-[#8e8e8e]">
                      {isTokenLimitReached ? '100k limit reached' : 'Generate photos'}
                    </p>
                  </div>
                </div>
                {chatMode === 'photo' && !isTokenLimitReached && (
                  <span className="material-symbols-outlined text-[16px] text-emerald-400">check</span>
                )}
              </button>

              {/* Option 3: Video mode */}
              <button 
                disabled={isTokenLimitReached}
                onClick={() => {
                  if (isTokenLimitReached) return;
                  setChatMode('video');
                  setShowModeMenu(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-[12.5px] rounded-xl transition text-left ${
                  isTokenLimitReached
                    ? 'opacity-45 cursor-not-allowed text-[#9e9e9e]'
                    : chatMode === 'video'
                    ? 'bg-white/10 text-white font-medium cursor-pointer'
                    : 'text-[#d4d4d4] hover:bg-white/5 cursor-pointer'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[18px] text-purple-400">videocam</span>
                  <div>
                    <p className="leading-tight">Video</p>
                    <p className="text-[10.5px] text-[#8e8e8e]">
                      {isTokenLimitReached ? '100k limit reached' : 'Generate video'}
                    </p>
                  </div>
                </div>
                {chatMode === 'video' && !isTokenLimitReached && (
                  <span className="material-symbols-outlined text-[16px] text-purple-400">check</span>
                )}
              </button>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Rotating 5-Color Glowing Border */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="rotating-border-wrapper shadow-2xl"
          >
            <div className="rotating-conic-glow"></div>
            <div className="rotating-conic-sharp"></div>

            <div 
              className="relative bg-[#252525] rounded-[24px] p-3 sm:p-4 z-20 w-full cursor-text"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('button') && !target.closest('#upload-menu') && !target.closest('#mode-menu')) {
                  textareaRef.current?.focus();
                }
              }}
            >
              
              {/* Live Voice Recording Animation Bar (Max 5:00) */}
              <AnimatePresence>
              {isRecording && (
                <motion.div
                  id="voice-recording-bar"
                  initial={{ opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.98 }}
                  transition={{ duration: 0.18 }}
                  className="mb-3 flex items-center justify-between gap-2.5 px-3.5 py-2.5 rounded-2xl bg-red-500/10 border border-red-500/25 select-none"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                    </span>
                    <span className="text-[12px] font-medium text-red-200 shrink-0">Recording</span>

                    {/* Animated Waveform Equalizer */}
                    <div className="flex items-center gap-[3px] h-5 px-1.5" aria-hidden="true">
                      <span className="voice-wave-bar w-[3px] h-3 rounded-full bg-red-400 [animation-delay:0ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-5 rounded-full bg-red-400 [animation-delay:110ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-3.5 rounded-full bg-red-300 [animation-delay:220ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-5 rounded-full bg-red-400 [animation-delay:330ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-2.5 rounded-full bg-red-300 [animation-delay:160ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-4 rounded-full bg-red-400 [animation-delay:280ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-5 rounded-full bg-red-300 [animation-delay:70ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-3 rounded-full bg-red-400 [animation-delay:390ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-4 rounded-full bg-red-400 [animation-delay:190ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-5 rounded-full bg-red-300 [animation-delay:310ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-3 rounded-full bg-red-400 [animation-delay:130ms]"></span>
                      <span className="voice-wave-bar w-[3px] h-4 rounded-full bg-red-400 [animation-delay:250ms]"></span>
                    </div>
                  </div>

                  <span
                    id="recording-timer"
                    className="text-[12px] font-mono tabular-nums text-white font-semibold shrink-0"
                  >
                    {formatTime(recordingSeconds)}
                  </span>
                </motion.div>
              )}
              </AnimatePresence>

              {/* Ready-to-Send Recorded Voice Preview */}
              <AnimatePresence>
              {!isRecording && recordedVoice && (
                <motion.div
                  id="recorded-voice-preview"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.18 }}
                  className="mb-3 flex items-center"
                >
                  <VoiceAudioPlayer
                    src={recordedVoice.blobUrl}
                    durationSeconds={recordedVoice.durationSeconds}
                    onRemove={discardRecordedVoice}
                    compact
                  />
                </motion.div>
              )}
              </AnimatePresence>

              {/* Media File Previews */}
              {attachedFiles.length > 0 && (
                <div id="file-previews" className="flex flex-wrap items-center gap-2 mb-3 max-h-40 overflow-y-auto touch-pan-y pt-1 pb-1">
                  <AnimatePresence initial={false}>
                  {attachedFiles.map((item) => (
                    <motion.div 
                      key={item.id} 
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.88 }}
                      transition={{ duration: 0.16 }}
                      className="group relative flex items-center gap-2 bg-[#323232] border border-white/10 pl-1.5 pr-2.5 py-1.5 rounded-xl text-[12px] text-white shadow-sm"
                    >
                      {item.type === 'image' ? (
                        <img 
                          src={item.previewUrl} 
                          alt={item.name} 
                          className="w-7 h-7 object-cover rounded-lg border border-white/10 shrink-0" 
                        />
                      ) : (
                        <div className="w-7 h-7 bg-emerald-500/20 text-emerald-400 rounded-lg flex items-center justify-center shrink-0">
                          <span className="material-symbols-outlined text-[16px]">videocam</span>
                        </div>
                      )}
                      
                      <span className="truncate max-w-[130px] font-medium">{item.name}</span>

                      <button 
                        type="button" 
                        className="ml-1 w-5 h-5 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer transition"
                        onClick={() => removeAttachedFile(item.id)}
                        title="Remove file"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </motion.div>
                  ))}
                  </AnimatePresence>
                </div>
              )}

              <textarea 
                id="prompt-input"
                ref={textareaRef}
                rows={1}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onFocus={() => {
                  if (!currentUser) {
                    setShowLoginModal(true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!currentUser) {
                      setShowLoginModal(true);
                      return;
                    }
                    if (hasContent && !isThinking) handleSend();
                  }
                }}
                placeholder={currentUser ? getPlaceholderText() : 'Please sign in to chat, generate photos, or make videos...'}
                className="w-full bg-transparent text-white placeholder-[#7e7e7e] text-[15px] sm:text-[16px] outline-none mb-3 resize-none max-h-32 min-h-[36px] caret-white relative z-30 touch-pan-y"
              ></textarea>

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2">
                  {/* Add File Button */}
                  <motion.button 
                    id="add-file-btn" 
                    type="button" 
                    whileTap={{ scale: 0.9 }}
                    title="Add files" 
                    onClick={() => {
                      if (!currentUser) {
                        setShowLoginModal(true);
                        return;
                      }
                      setShowModeMenu(false);
                      setShowUploadMenu((prev) => !prev);
                    }}
                    className="w-8 h-8 rounded-full flex items-center justify-center neutral-btn shadow-sm cursor-pointer hover:bg-white/10 transition relative"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                  </motion.button>

                  {/* Mode Selector Button (3 Options: Chat, Photo, Video) */}
                  <motion.button
                    id="mode-selector-btn"
                    type="button"
                    whileTap={{ scale: 0.94 }}
                    onClick={() => {
                      if (!currentUser) {
                        setShowLoginModal(true);
                        return;
                      }
                      setShowUploadMenu(false);
                      setShowModeMenu((prev) => !prev);
                    }}
                    className="h-8 px-2.5 rounded-full neutral-btn shadow-sm cursor-pointer hover:bg-white/10 transition flex items-center gap-1.5 text-[12px] font-medium text-[#d1d5db]"
                    title="Change Mode"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={chatMode}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.14 }}
                        className="flex items-center gap-1.5"
                      >
                        {chatMode === 'chat' && (
                          <>
                            <span className="material-symbols-outlined text-[16px] text-blue-400">chat_bubble</span>
                            <span>Chat</span>
                          </>
                        )}
                        {chatMode === 'photo' && (
                          <>
                            <span className="material-symbols-outlined text-[16px] text-emerald-400">image</span>
                            <span className="text-emerald-300">Photo</span>
                          </>
                        )}
                        {chatMode === 'video' && (
                          <>
                            <span className="material-symbols-outlined text-[16px] text-purple-400">videocam</span>
                            <span className="text-purple-300">Video</span>
                          </>
                        )}
                      </motion.span>
                    </AnimatePresence>
                    <span className="material-symbols-outlined text-[14px] text-gray-400">expand_more</span>
                  </motion.button>
                </div>

                <div className="flex items-center gap-2">
                  {/* Mic / Red Stop Button */}
                  <motion.button 
                    id="mic-btn" 
                    type="button" 
                    whileTap={{ scale: 0.9 }}
                    title={isRecording ? "Stop recording" : "Record voice"}
                    onClick={toggleMic}
                    className={`w-8 h-8 rounded-full flex items-center justify-center shadow-sm relative cursor-pointer transition ${
                      isRecording
                        ? 'bg-red-500 hover:bg-red-600 text-white shadow-md'
                        : 'neutral-btn hover:bg-white/10'
                    }`}
                  >
                    <span id="mic-icon" className="material-symbols-outlined text-[18px]">
                      {isRecording ? 'stop' : 'mic'}
                    </span>
                  </motion.button>
                  
                  {/* Send Button: ALWAYS shows "Run" per user instruction */}
                  <motion.button 
                    id="run-btn" 
                    whileTap={hasContent && !isThinking ? { scale: 0.94 } : undefined}
                    disabled={!hasContent || isThinking}
                    onClick={handleSend}
                    className={
                      hasContent && !isThinking
                        ? "px-4 py-1.5 bg-white text-black text-[13px] font-semibold rounded-xl cursor-pointer hover:bg-gray-200 transition-all duration-150 flex items-center gap-1 shadow-sm"
                        : "px-4 py-1.5 bg-[#1f1f1f] border border-white/10 text-[#6e6e6e] text-[13px] font-semibold rounded-xl cursor-not-allowed transition-all duration-150"
                    }
                  >
                    <span>Run</span>
                  </motion.button>
                </div>
              </div>
            </div>
          </motion.div>
          </div>
        </div>

        {/* Auth Modal: Google Sign-in (only shown when not already logged in) */}
        {!currentUser && (
          <AuthModal
            isOpen={showLoginModal}
            onClose={() => setShowLoginModal(false)}
            onLoginSuccess={(user) => {
              setCurrentUser(user);
              setShowLoginModal(false);
            }}
          />
        )}

        {/* Profile Modal: Small panel with Usage & Settings */}
        {currentUser && (
          <ProfileModal
            isOpen={showProfileModal}
            onClose={() => setShowProfileModal(false)}
            currentUser={currentUser}
            tokenAllowance={effectiveAllowance}
            nowTick={nowTick}
            genSettings={genSettings}
            onUpdateGenSettings={updateGenSettings}
            onLogout={handleLogout}
            formatTokenUsageValue={formatTokenUsageValue}
            formatResetCountdown={formatResetCountdown}
            dailyTokenLimit={DAILY_TOKEN_LIMIT}
          />
        )}

      </div>
    </div>
    </MotionConfig>
  );
}
