/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import { HistorySidebar } from './components/HistorySidebar';
import { AuthModal } from './components/AuthModal';
import { ProfileModal } from './components/ProfileModal';
import { VoiceAudioPlayer } from './components/VoiceAudioPlayer';
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
          parsed?.videoDuration === 5 || parsed?.videoDuration === 10
            ? parsed.videoDuration
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
const PHOTO_TOKEN_COST = 1_000; // 1k tokens per photo generation
const VIDEO_TOKEN_COST = 2_000; // 2k tokens per video generation

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

// --- XKIRO API CONFIGURATION (NO PUTER) ---
const XKIRO_API_KEY = "sk-xt-ade0b61c4b191d01fd80b003eeff6ade5bfc774538bb64af";
const XKIRO_BASE_URL = "https://api.xkiro.com/v1/chat/completions";
const XKIRO_MODEL = "qwen/qwen3.8-omni-flash:free";

// Default logged-in account information
const DEFAULT_GOOGLE_USER: UserAccount = {
  name: 'Gamertisk',
  email: 'gamertisk@gmail.com',
};

export default function App() {
  // Gemini-style Chat Sessions History
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem('gutiai_chat_history');
      if (saved) return JSON.parse(saved);
    } catch (_e) {}
    return [];
  });

  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('gutiai_active_session_id') || null;
    } catch (_e) {
      return null;
    }
  });

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

  // Refs
  const chatCanvasRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const docFileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef<boolean>(false);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingSecondsRef = useRef<number>(0);
  const videoProgressFloorRef = useRef<number>(0);
  const videoTickCountRef = useRef<number>(0);
  const videoBlobUrlsRef = useRef<Record<string, string>>({});

  // Load saved user session, subscribe to Firebase Auth, and load active chat messages on mount
  useEffect(() => {
    initAnalytics().catch(() => {});

    const savedUser = localStorage.getItem('gutiai_user_session');
    if (savedUser) {
      try {
        setCurrentUser(JSON.parse(savedUser));
      } catch (e) {
        // Ignore JSON error
      }
    }

    // Subscribe to real-time Firebase Auth state changes
    const unsubscribeAuth = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        const user: UserAccount = {
          uid: fbUser.uid,
          name: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : 'User'),
          email: fbUser.email || 'gamertisk@gmail.com',
          avatarUrl: fbUser.photoURL || undefined,
        };
        setCurrentUser(user);
        localStorage.setItem('gutiai_user_session', JSON.stringify(user));
      } else {
        const cached = localStorage.getItem('gutiai_user_session');
        if (!cached) {
          setCurrentUser(null);
        }
      }
    });

    if (activeSessionId) {
      const active = sessions.find((s) => s.id === activeSessionId);
      if (active && active.messages && active.messages.length > 0) {
        setMessages(active.messages);
        if (active.chatMode) {
          setChatMode(active.chatMode);
        }
      }
    }

    return () => {
      unsubscribeAuth();
    };
  }, []);

  // Real-time synchronization of chat history with cloud Firestore database
  useEffect(() => {
    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (!effectiveUid) return;

    const unsubscribeSessions = subscribeToUserSessions(effectiveUid, (cloudSessions) => {
      if (cloudSessions && cloudSessions.length > 0) {
        setSessions(cloudSessions);
        // Also keep local cache updated so conversations are instantly accessible offline
        try {
          localStorage.setItem('gutiai_chat_history', JSON.stringify(cloudSessions));
        } catch (_e) {}
      }
    });

    return () => {
      unsubscribeSessions();
    };
  }, [currentUser?.uid]);

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

  // Persist sessions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('gutiai_chat_history', JSON.stringify(sessions));
    } catch (_e) {}
  }, [sessions]);

  // Persist activeSessionId to localStorage
  useEffect(() => {
    try {
      if (activeSessionId) {
        localStorage.setItem('gutiai_active_session_id', activeSessionId);
      } else {
        localStorage.removeItem('gutiai_active_session_id');
      }
    } catch (_e) {}
  }, [activeSessionId]);

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
    if (!url || videoBlobUrlsRef.current[url]) return;
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

  // Download full 10s 16:9 MP4 video with music cleanly via Blob URL
  const downloadVideo = async (url: string, filename: string) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
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

    const currentPhotos = attachedFiles.filter(f => f.type === 'image');
    const currentVideos = attachedFiles.filter(f => f.type === 'video');

    const newPhotos = filesArray.filter(f => f.type.startsWith('image/'));
    const newVideos = filesArray.filter(f => f.type.startsWith('video/'));
    const otherFiles = filesArray.filter(f => !f.type.startsWith('image/') && !f.type.startsWith('video/'));

    const filesToAdd: File[] = [];

    const photoSlots = Math.max(0, 10 - currentPhotos.length);
    if (newPhotos.length > 0 && photoSlots > 0) {
      filesToAdd.push(...newPhotos.slice(0, photoSlots));
    }

    const videoSlots = Math.max(0, 1 - currentVideos.length);
    if (newVideos.length > 0 && videoSlots > 0) {
      filesToAdd.push(newVideos[0]);
    }

    if (otherFiles.length > 0) {
      filesToAdd.push(...otherFiles);
    }

    const processedMedia: AttachedMedia[] = [];
    for (const file of filesToAdd) {
      const isVideo = file.type.startsWith('video/');
      const previewUrl = URL.createObjectURL(file);
      const base64Data = await fileToBase64(file);

      processedMedia.push({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        name: file.name,
        mimeType: file.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
        type: isVideo ? 'video' : 'image',
        previewUrl,
        base64Data,
      });
    }

    setAttachedFiles(prev => [...prev, ...processedMedia]);
  };

  const removeAttachedFile = (id: string) => {
    setAttachedFiles(prev => {
      const target = prev.find(item => item.id === id);
      if (target?.previewUrl) {
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

  // Google Login handling
  const handleGoogleLogin = () => {
    setIsLoggingIn(true);
    setTimeout(() => {
      setCurrentUser(DEFAULT_GOOGLE_USER);
      localStorage.setItem('gutiai_user_session', JSON.stringify(DEFAULT_GOOGLE_USER));
      setIsLoggingIn(false);
      setShowLoginModal(false);
    }, 400);
  };

  const handleLogout = async () => {
    try {
      await logOutFromFirebase();
    } catch (_e) {}
    setCurrentUser(null);
    localStorage.removeItem('gutiai_user_session');
  };

  // Helper to sync or create a session in history
  // Helper to sync or create a session in history and persist permanently to Firestore database
  const syncSession = (sessId: string, updatedMsgs: Message[], fallbackTitle?: string) => {
    let sessionToSave: ChatSession | null = null;
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === sessId);
      if (idx !== -1) {
        const updated = [...prev];
        const updatedSession = {
          ...updated[idx],
          messages: updatedMsgs,
          updatedAt: Date.now(),
        };
        updated[idx] = updatedSession;
        sessionToSave = updatedSession;
        return updated;
      } else {
        const title = fallbackTitle || 'New chat';
        const newSession: ChatSession = {
          id: sessId,
          title,
          messages: updatedMsgs,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          chatMode,
        };
        sessionToSave = newSession;
        return [newSession, ...prev];
      }
    });

    // Save permanently to cloud Firestore database
    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid && sessionToSave) {
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
    let sessionToSave: ChatSession | null = null;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === sessionId) {
          const updated = { ...s, title: newTitle, updatedAt: Date.now() };
          sessionToSave = updated;
          return updated;
        }
        return s;
      })
    );

    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid && sessionToSave) {
      saveSessionToFirestore(effectiveUid, sessionToSave).catch(() => {});
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      handleNewChat();
    }

    const effectiveUid = currentUser?.uid || auth.currentUser?.uid;
    if (effectiveUid) {
      deleteSessionFromFirestore(effectiveUid, sessionId).catch(() => {});
    }
  };

  const handleClearAllSessions = () => {
    setSessions([]);
    handleNewChat();
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

    let userPrompt = text;
    if (!userPrompt && !currentVoice && currentAttachments.length > 0) {
      userPrompt = currentAttachments.some((a) => a.type === 'video')
        ? 'Please analyze this video and explain its key content.'
        : 'Please examine and describe these photos in detail.';
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
    setPendingMode(chatMode);
    if (chatMode === 'photo') {
      setPendingPhotoAspect(genSettings.photoAspectRatio);
      setThinkingLabel('Creating your image');
    } else if (chatMode === 'video') {
      setPendingVideoAspect(genSettings.videoAspectRatio);
      setThinkingLabel('Generating video...');
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
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.text && typeof data.text === 'string' && data.text.trim()) {
            const spoken = data.text.trim();
            if (wasNewSession && currentSessionId) {
              handleRenameSession(currentSessionId, spoken.slice(0, 36));
            }
            return spoken;
          }
        }
      } catch (_tErr) {}
      return '';
    };

    // Photo Mode: Dark luminous creation card ("Creating your image") -> seamless decoded reveal
    if (chatMode === 'photo') {
      setThinkingLabel('Creating your image');
      try {
        const resolvedPrompt = await resolveSpokenPromptIfNeeded();
        const cleanPrompt =
          resolvedPrompt.trim() || 'natural candid street scene in warm afternoon sunlight';
        const selectedPhotoAspect = genSettings.photoAspectRatio;
        const selectedPhotoQuality = genSettings.photoQuality;

        let generatedUrl: string | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch('/api/generate-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                prompt: cleanPrompt,
                aspectRatio: selectedPhotoAspect,
                quality: selectedPhotoQuality,
              }),
              signal: AbortSignal.timeout(45000),
            });

            if (response.ok) {
              const data = await response.json();
              const imageUrl = data?.imageUrl;
              if (imageUrl && imageUrl.startsWith('data:image/')) {
                await preloadImage(imageUrl, 5000);
                generatedUrl = imageUrl;
                break;
              } else if (imageUrl && imageUrl.startsWith('http')) {
                const isLoaded = await preloadImage(imageUrl);
                if (isLoaded) {
                  generatedUrl = imageUrl;
                  break;
                }
              }
            }
          } catch {
            // Transient fetch hiccup; retry below
          }
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
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
                aspectRatio: selectedPhotoAspect,
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
            content: 'Image generation took longer than expected. Please try again in a few moments.',
          },
        ];
        setMessages(fallbackHistory);
        syncSession(currentSessionId, fallbackHistory);
      } catch (_err: any) {
        const errHistory: Message[] = [
          ...newHistory,
          {
            role: 'assistant',
            content: 'Image generation took longer than expected. Please try again in a few moments.',
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
      setThinkingLabel('Generating video...');
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

        const selectedDuration: VideoDuration = genSettings.videoDuration === 5 ? 5 : 10;
        const selectedAspect = genSettings.videoAspectRatio;
        const selectedQuality = genSettings.videoQuality;

        const framingText =
          selectedAspect === '9:16'
            ? 'Cinematic real-world vertical 9:16 live-action video of'
            : selectedAspect === '1:1'
            ? 'Cinematic real-world 1:1 live-action video of'
            : 'Cinematic real-world 16:9 widescreen live-action video of';
        const wanPrompt = `${framingText} ${cleanPrompt}, fluid natural 3D motion, continuous smooth movement, realistic physics, authentic 35mm cinema lighting, rich detail, sharp optical focus.`;
        const wanNeg =
          'static, blurred details, subtitles, paintings, still picture, worst quality, low quality, ugly, deformed, camera zoom, ken burns effect, watermark, text, signature';

        let finalVideoUrl: string | null = null;

        // Stream Gradio SSE with live step-by-step % updates + async EPZS 30fps server mastering
        const callWanSpaceAndMaster = async (
          spaceBase: string,
          endpoint: string,
          payloadData: unknown[],
          sseStartPct: number,
          sseEndPct: number
        ): Promise<{ url: string | null; quotaExceeded: boolean }> => {
          try {
            const postRes = await fetch(`${spaceBase}/gradio_api/call${endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: payloadData }),
              signal: AbortSignal.timeout(14000),
            });
            if (!postRes.ok) {
              const errBody = await postRes.text().catch(() => '');
              return {
                url: null,
                quotaExceeded: /ZeroGPU quota|exceeded your.*quota/i.test(errBody),
              };
            }
            const postJson = await postRes.json();
            const eventId = postJson?.event_id;
            if (!eventId) return { url: null, quotaExceeded: false };

            const sseRes = await fetch(`${spaceBase}/gradio_api/call${endpoint}/${eventId}`, {
              signal: AbortSignal.timeout(95000),
            });
            if (!sseRes.ok || !sseRes.body) return { url: null, quotaExceeded: false };

            const reader = sseRes.body.getReader();
            const decoder = new TextDecoder();
            let sseText = '';
            let stepRatio = 0.06;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              sseText += chunk;

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
                  url: null,
                  quotaExceeded: /ZeroGPU quota|exceeded your.*quota/i.test(sseText),
                };
              }
            }

            const urlMatch = sseText.match(/"url":\s*"([^"]+\.mp4[^"]*)"/i);
            const pathMatch = sseText.match(/"path":\s*"([^"]+\.mp4)"/i);
            const rawVideoUrl = urlMatch?.[1]
              ? urlMatch[1].startsWith('http')
                ? urlMatch[1]
                : `${spaceBase}/gradio_api/file=${urlMatch[1]}`
              : pathMatch?.[1]
              ? `${spaceBase}/gradio_api/file=${pathMatch[1]}`
              : null;
            if (!rawVideoUrl) {
              return {
                url: null,
                quotaExceeded: /ZeroGPU quota|exceeded your.*quota/i.test(sseText),
              };
            }

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
              signal: AbortSignal.timeout(15000),
            });
            if (!masterRes.ok) return { url: null, quotaExceeded: false };
            const masterJson = await masterRes.json();
            if (masterJson?.videoUrl) return { url: masterJson.videoUrl, quotaExceeded: false };

            const masterJobId = masterJson?.jobId;
            if (!masterJobId) return { url: null, quotaExceeded: false };

            for (let mPoll = 0; mPoll < 95; mPoll++) {
              await new Promise((r) => setTimeout(r, 850));
              try {
                const mStatusRes = await fetch(`/api/generate-video/status/${masterJobId}`, {
                  signal: AbortSignal.timeout(8000),
                });
                if (!mStatusRes.ok) continue;
                const mStatusJson = await mStatusRes.json();
                if (typeof mStatusJson?.progress === 'number') {
                  advanceVideoFloor(mStatusJson.progress);
                }
                if (mStatusJson?.status === 'completed' && mStatusJson?.videoUrl) {
                  return { url: mStatusJson.videoUrl, quotaExceeded: false };
                }
                if (mStatusJson?.status === 'failed') break;
              } catch {
                // Continue polling on transient network hiccup
              }
            }
            return { url: null, quotaExceeded: false };
          } catch {
            return { url: null, quotaExceeded: false };
          }
        };

        // 1. Primary: Wan-AI/Wan2.2-T2V-A14B (4.2s = 68 native frames, 4-step Lightx2v distillation)
        const wan22AspectChoice =
          selectedAspect === '9:16'
            ? '9:16 (480x832)'
            : selectedAspect === '1:1'
            ? '1:1 (640x640)'
            : '16:9 (832x480)';
        const tier1Result = await callWanSpaceAndMaster(
          'https://upsampler-wan-2-2-14b-text-to-video.hf.space',
          '/generate_video',
          [
            wanPrompt,
            wan22AspectChoice,
            4,
            wanNeg,
            4.2,
            1,
            1,
            Math.floor(Math.random() * 2147483647),
            true,
          ],
          10,
          81
        );
        finalVideoUrl = tier1Result.url;

        // Only probe secondary/tertiary ZeroGPU Spaces if browser ZeroGPU quota wasn't exhausted on Tier 1
        if (!finalVideoUrl && !tier1Result.quotaExceeded) {
          // 2. Secondary: Wan-AI/Wan2.2-TI2V-5B (Native 24fps 5.0s = 120 native frames @ 832x480 / 480x832 / 640x640)
          const [wanH, wanW] =
            selectedAspect === '9:16'
              ? [832, 480]
              : selectedAspect === '1:1'
              ? [640, 640]
              : [480, 832];
          const tier2Result = await callWanSpaceAndMaster(
            'https://upsampler-wan-2-2-5b-video.hf.space',
            '/generate_video',
            [
              null,
              wanPrompt,
              wanH,
              wanW,
              wanNeg,
              5.0,
              0,
              4,
              Math.floor(Math.random() * 2147483647),
              true,
            ],
            14,
            81
          );
          finalVideoUrl = tier2Result.url;

          // 3. Tertiary: rCM-Wan 2.1 14B Text-to-Video (77 native frames, 4 steps)
          if (!finalVideoUrl && !tier2Result.quotaExceeded) {
            const tier3Result = await callWanSpaceAndMaster(
              'https://yujiwang0606-rcm-wan.hf.space',
              '/generate_videos',
              [
                wanPrompt,
                'rCM-Wan2.1-T2V-14B-480p',
                1,
                selectedAspect === '9:16' ? '9:16' : '16:9',
                80,
                4,
                Math.floor(Math.random() * 900000000) + 1,
              ],
              18,
              81
            );
            finalVideoUrl = tier3Result.url;
          }
        }

        // 4. Server-authenticated Wan + dedicated GPU cluster job failover
        for (let jobAttempt = 0; jobAttempt < 2 && !finalVideoUrl; jobAttempt++) {
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
              signal: AbortSignal.timeout(20000),
            });

            if (!startRes.ok) continue;
            const startData = await startRes.json();

            if (startData?.videoUrl) {
              finalVideoUrl = startData.videoUrl;
              break;
            }

            const jobId = startData?.jobId;
            if (!jobId) continue;

            for (let pollIdx = 0; pollIdx < 240; pollIdx++) {
              await new Promise((r) => setTimeout(r, 950));
              try {
                const pollRes = await fetch(`/api/generate-video/status/${jobId}`, {
                  signal: AbortSignal.timeout(10000),
                });
                if (!pollRes.ok) {
                  if (pollRes.status === 404) break;
                  continue;
                }
                const pollData = await pollRes.json();
                if (typeof pollData?.progress === 'number') {
                  advanceVideoFloor(pollData.progress);
                }
                if (pollData?.status === 'completed' && pollData?.videoUrl) {
                  finalVideoUrl = pollData.videoUrl;
                  break;
                }
                if (pollData?.status === 'failed') {
                  break;
                }
              } catch {
                // Ignore transient network poll hiccup and continue polling
              }
            }
          } catch {
            // Retry starting job once if initial POST had a transient network hiccup
          }
        }

        if (finalVideoUrl) {
          advanceVideoFloor(99);
          setVideoProgress((prev) => Math.max(prev, 99));
          await preloadVideoInMemory(finalVideoUrl);
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
      const payloadAttachments = currentAttachments.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        data: a.base64Data,
      }));

      if (currentVoice && currentVoice.base64Data) {
        payloadAttachments.push({
          name: 'voice-message.webm',
          mimeType: currentVoice.mimeType,
          data: currentVoice.base64Data,
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
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned ${response.status}`);
      }

      const data = await response.json();
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
    if (chatMode === 'photo') return 'Describe the photo you want to generate...';
    if (chatMode === 'video') return 'Describe the video you want to generate...';
    return 'Ask a question...';
  };

  return (
    <div className="h-screen h-[100dvh] w-full text-[#e3e3e3] flex flex-col overflow-hidden bg-[#0b0c0f] relative">
      {/* Main Content */}
      <div className="w-full flex-1 flex flex-col justify-between max-w-4xl mx-auto h-full min-h-0 relative">
          
          {/* Top Header */}
          <header className="w-full flex items-center justify-between px-4 sm:px-6 pt-4 pb-2 z-30 shrink-0">
            <div className="relative flex items-center gap-2.5 sm:gap-3.5 min-w-0">
              <button 
                id="toggle-sidebar-btn"
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
              </button>

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

              <span className="font-bold text-[17px] tracking-tight text-white hidden sm:inline whitespace-nowrap shrink-0">
                BloopX
              </span>

              {activeSessionId && (
                <span className="text-[13px] text-gray-400 truncate max-w-[130px] sm:max-w-[260px] hidden md:inline">
                  {sessions.find((s) => s.id === activeSessionId)?.title || ''}
                </span>
              )}
            </div>

          {/* User Profile (when logged in) or Login Action */}
          <div className="relative flex items-center gap-2">
            {!currentUser ? (
              <button
                id="open-login-btn"
                onClick={() => setShowLoginModal(true)}
                className="h-8 px-3.5 neutral-btn active:scale-95 text-[12px] font-medium rounded-full flex items-center shadow-sm cursor-pointer hover:bg-[#252831] transition"
              >
                <span>Log in</span>
              </button>
            ) : (
              <button
                id="user-profile-btn"
                type="button"
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
                className="h-8 pl-1 pr-2 rounded-full bg-[#1e2027] hover:bg-[#252731] border border-white/10 hover:border-white/20 flex items-center gap-1.5 shadow-sm cursor-pointer transition select-none"
                title={`${currentUser.name} - View profile`}
                aria-label="View profile"
              >
                {currentUser.avatarUrl ? (
                  <img
                    src={currentUser.avatarUrl}
                    alt={currentUser.name}
                    className="w-6 h-6 rounded-full object-cover border border-white/20"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-[#3b3e4a] to-[#252731] border border-white/20 flex items-center justify-center text-[11px] font-semibold text-white">
                    {(currentUser.name || currentUser.email || 'U').trim().charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="text-[12px] font-medium text-gray-200 truncate max-w-[80px] sm:max-w-[120px] hidden sm:inline">
                  {currentUser.name}
                </span>
              </button>
            )}
          </div>
        </header>

        {/* Chat Canvas */}
        <div id="chat-canvas" ref={chatCanvasRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col z-10">
          {messages.length === 0 && !isThinking ? (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center px-4 select-none my-auto" id="empty-state">
              <h1 className="text-3xl sm:text-5xl md:text-6xl font-semibold text-[#e3e3e3] tracking-tight leading-tight max-w-3xl drop-shadow-sm">
                What would you like to explore today?
              </h1>
            </div>
          ) : (
            <div className="space-y-5 w-full flex-1">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} w-full`}>
                  {msg.role === 'user' ? (
                    <div className="max-w-[85%] sm:max-w-[75%] flex flex-col items-end">
                      <div
                        className="w-full bg-[#1e2027] text-white px-4 py-2.5 rounded-2xl text-[14.5px] leading-relaxed break-words border border-white/5 space-y-2.5"
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
                                    <div className="w-40 h-28 flex flex-col items-center justify-center bg-[#13151b] p-2 text-center">
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
                        <div
                          className={`w-full media-reveal ${
                            msg.generatedVideo.aspectRatio === '9:16'
                              ? 'max-w-[280px]'
                              : msg.generatedVideo.aspectRatio === '1:1'
                              ? 'max-w-md'
                              : 'max-w-xl'
                          }`}
                        >
                          <div className="rounded-[24px] overflow-hidden border border-white/[0.08] bg-[#14151b] shadow-2xl group">
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
                        </div>
                      ) : msg.generatedPhoto ? (
                        <div
                          className={`w-full media-reveal ${
                            msg.generatedPhoto.aspectRatio === '9:16'
                              ? 'max-w-[280px]'
                              : msg.generatedPhoto.aspectRatio === '3:4'
                              ? 'max-w-[330px]'
                              : msg.generatedPhoto.aspectRatio === '16:9'
                              ? 'max-w-lg'
                              : 'max-w-md'
                          }`}
                        >
                          <div className="rounded-[24px] overflow-hidden border border-white/[0.08] bg-[#14151b] shadow-xl">
                            <div
                              className={`relative overflow-hidden bg-black/40 flex items-center justify-center cursor-pointer group select-none ${
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
                                className="w-full h-full object-cover select-none pointer-events-none"
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
                        </div>
                      ) : (
                        /* Markdown Text Response for chat */
                        <div dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }} />
                      )}
                    </div>
                  )}
                </div>
              ))}

              {isThinking && (
                <div className="flex justify-start w-full px-2 py-1">
                  {pendingMode === 'photo' ? (
                    <div
                      id="photo-creation-placeholder"
                      className={`w-full select-none ${
                        pendingPhotoAspect === '9:16'
                          ? 'max-w-[280px]'
                          : pendingPhotoAspect === '3:4'
                          ? 'max-w-[330px]'
                          : pendingPhotoAspect === '16:9'
                          ? 'max-w-lg'
                          : 'max-w-md'
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
                          Creating your image
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
                          ? 'max-w-[280px]'
                          : pendingVideoAspect === '1:1'
                          ? 'max-w-md'
                          : 'max-w-xl'
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
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px] text-[#118ab2] animate-spin">
                        progress_activity
                      </span>
                      <span className="thinking-shimmer text-[14px] font-medium">{thinkingLabel}</span>
                    </div>
                  )}
                </div>
              )}
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
          accept="image/*,video/*,application/pdf" 
          multiple 
          className="hidden" 
          onChange={(e) => {
            if (e.target.files) handleFilesSelect(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Prompt Input Container */}
        <div className="p-3 sm:p-5 z-20 w-full relative shrink-0">

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
          {showUploadMenu && (
            <div 
              id="upload-menu" 
              className="absolute left-4 sm:left-6 bottom-20 sm:bottom-24 bg-[#181a20] rounded-2xl p-1.5 shadow-2xl z-30 w-52 border border-white/5"
            >
              <button 
                id="upload-media-btn" 
                onClick={() => {
                  mediaFileInputRef.current?.click();
                  setShowUploadMenu(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#e3e3e3] hover:bg-white/5 rounded-xl transition text-left cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] text-[#9aa0a6]">perm_media</span>
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
                <span className="material-symbols-outlined text-[18px] text-[#9aa0a6]">upload_file</span>
                <span>Upload files</span>
              </button>
            </div>
          )}

          {/* Mode Selector Menu (Only 2 Options: Chat, Photo) */}
          {showModeMenu && (
            <div 
              id="mode-menu" 
              className="absolute left-14 sm:left-16 bottom-20 sm:bottom-24 bg-[#181a20] rounded-2xl p-1.5 shadow-2xl z-30 w-48 border border-white/10 animate-fade-in"
            >
              {/* Option 1: Chat mode */}
              <button 
                onClick={() => {
                  setChatMode('chat');
                  setShowModeMenu(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-[12.5px] rounded-xl transition text-left cursor-pointer ${
                  chatMode === 'chat' ? 'bg-white/10 text-white font-medium' : 'text-[#d1d5db] hover:bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[18px] text-blue-400">chat_bubble</span>
                  <div>
                    <p className="leading-tight">Chat</p>
                    <p className="text-[10.5px] text-[#8e918f]">Chat with AI</p>
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
                    ? 'opacity-45 cursor-not-allowed text-[#9aa0a6]'
                    : chatMode === 'photo'
                    ? 'bg-white/10 text-white font-medium cursor-pointer'
                    : 'text-[#d1d5db] hover:bg-white/5 cursor-pointer'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[18px] text-emerald-400">image</span>
                  <div>
                    <p className="leading-tight">Photo</p>
                    <p className="text-[10.5px] text-[#8e918f]">
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
                    ? 'opacity-45 cursor-not-allowed text-[#9aa0a6]'
                    : chatMode === 'video'
                    ? 'bg-white/10 text-white font-medium cursor-pointer'
                    : 'text-[#d1d5db] hover:bg-white/5 cursor-pointer'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="material-symbols-outlined text-[18px] text-purple-400">videocam</span>
                  <div>
                    <p className="leading-tight">Video</p>
                    <p className="text-[10.5px] text-[#8e918f]">
                      {isTokenLimitReached ? '100k limit reached' : 'Generate video'}
                    </p>
                  </div>
                </div>
                {chatMode === 'video' && !isTokenLimitReached && (
                  <span className="material-symbols-outlined text-[16px] text-purple-400">check</span>
                )}
              </button>
            </div>
          )}



          {/* Rotating 5-Color Glowing Border */}
          <div className="rotating-border-wrapper shadow-2xl">
            <div className="rotating-conic-glow"></div>
            <div className="rotating-conic-sharp"></div>

            <div 
              className="relative bg-[#131419] rounded-[24px] p-3 sm:p-4 z-20 w-full cursor-text"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('button') && !target.closest('#upload-menu') && !target.closest('#mode-menu')) {
                  textareaRef.current?.focus();
                }
              }}
            >
              
              {/* Live Voice Recording Animation Bar (Max 5:00 — No Cancel / Extra Stop Buttons) */}
              {isRecording && (
                <div
                  id="voice-recording-bar"
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
                </div>
              )}

              {/* Ready-to-Send Recorded Voice Preview */}
              {!isRecording && recordedVoice && (
                <div id="recorded-voice-preview" className="mb-3 flex items-center">
                  <VoiceAudioPlayer
                    src={recordedVoice.blobUrl}
                    durationSeconds={recordedVoice.durationSeconds}
                    onRemove={discardRecordedVoice}
                    compact
                  />
                </div>
              )}

              {/* Media File Previews */}
              {attachedFiles.length > 0 && (
                <div id="file-previews" className="flex flex-wrap items-center gap-2 mb-3 max-h-40 overflow-y-auto pt-1 pb-1">
                  {attachedFiles.map((item) => (
                    <div 
                      key={item.id} 
                      className="group relative flex items-center gap-2 bg-[#1b1d24] border border-white/10 pl-1.5 pr-2.5 py-1.5 rounded-xl text-[12px] text-white shadow-sm"
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
                    </div>
                  ))}
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
                className="w-full bg-transparent text-white placeholder-[#8e918f] text-[15px] sm:text-[16px] outline-none mb-3 resize-none max-h-32 min-h-[36px] caret-white relative z-30"
              ></textarea>

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2">
                  {/* Add File Button */}
                  <button 
                    id="add-file-btn" 
                    type="button" 
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
                  </button>

                  {/* Mode Selector Button (3 Options: Chat, Photo, Video) */}
                  <button
                    id="mode-selector-btn"
                    type="button"
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
                    <span className="material-symbols-outlined text-[14px] text-gray-400">expand_more</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {/* Mic / Red Stop Button */}
                  <button 
                    id="mic-btn" 
                    type="button" 
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
                  </button>
                  
                  {/* Send Button: ALWAYS shows "Run" per user instruction */}
                  <button 
                    id="run-btn" 
                    disabled={!hasContent || isThinking}
                    onClick={handleSend}
                    className={
                      hasContent && !isThinking
                        ? "px-4 py-1.5 bg-white text-black text-[13px] font-semibold rounded-xl cursor-pointer hover:bg-gray-200 transition-all duration-150 flex items-center gap-1"
                        : "px-4 py-1.5 bg-[#1b1c22] text-[#5f6368] text-[13px] font-semibold rounded-xl cursor-not-allowed transition-all duration-150"
                    }
                  >
                    <span>Run</span>
                  </button>
                </div>
              </div>
            </div>
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

        {/* Profile Modal: Small panel matching reference photo with Usage & Settings */}
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
  );
}
