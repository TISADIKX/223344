export type ChatMode = 'chat' | 'photo' | 'video';

export interface AttachedMedia {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  type: 'image' | 'video';
  previewUrl: string;
  base64Data: string;
}

export interface RecordedVoice {
  id: string;
  blobUrl: string;
  dataUri: string;
  base64Data: string;
  mimeType: string;
  durationSeconds: number;
}

export interface MessageAttachment {
  name: string;
  type: 'image' | 'video' | 'audio';
  previewUrl: string;
  durationSeconds?: number;
}

export type PhotoAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export type PhotoQuality = 'standard' | 'hd' | 'ultra';

export type VideoAspectRatio = '16:9' | '9:16' | '1:1';
export type VideoDuration = 5 | 10;
export type VideoQuality = '480p' | '720p' | '1080p';

export type AspectRatio = PhotoAspectRatio;

export interface GenerationSettings {
  photoQuality: PhotoQuality;
  photoAspectRatio: PhotoAspectRatio;
  videoDuration: VideoDuration;
  videoAspectRatio: VideoAspectRatio;
  videoQuality: VideoQuality;
}

export interface GeneratedPhoto {
  url: string;
  prompt: string;
  aspectRatio?: PhotoAspectRatio;
  quality?: PhotoQuality;
}

export interface GeneratedVideo {
  url: string;
  prompt: string;
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  quality?: VideoQuality;
  model?: string;
  provider?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  voiceTranscript?: string;
  attachments?: MessageAttachment[];
  generatedPhoto?: GeneratedPhoto;
  generatedVideo?: GeneratedVideo;
}

export interface UserAccount {
  uid?: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export interface UserTokenAllowance {
  usedTokens: number;
  limitTokens: number;
  resetAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  chatMode: ChatMode;
}
