import React, { useState } from 'react';
import { UserAccount } from '../types';
import { signInWithGoogle } from '../firebase';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (user: UserAccount) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Google SSO Sign-in via Firebase
  const handleGoogleSSO = async () => {
    setErrorMsg(null);
    setIsLoading(true);
    try {
      const fbUser = await signInWithGoogle();
      const user: UserAccount = {
        uid: fbUser.uid,
        name: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : 'User'),
        email: fbUser.email || 'gamertisk@gmail.com',
        avatarUrl: fbUser.photoURL || undefined,
      };
      localStorage.setItem('gutiai_user_session', JSON.stringify(user));
      setIsLoading(false);
      onLoginSuccess(user);
    } catch (err: any) {
      console.warn('Firebase Google Auth:', err?.code, err?.message);
      setIsLoading(false);
      
      // If user closed popup deliberately
      if (err?.code === 'auth/popup-closed-by-user') {
        return;
      }
      
      // If popup was blocked by the browser/iframe, give helpful instruction
      if (err?.code === 'auth/popup-blocked') {
        setErrorMsg('Google sign-in popup was blocked by your browser. Please allow popups for this site or open in a new tab.');
        return;
      }

      // If configuration domain is not authorized in Firebase Console yet
      if (err?.code === 'auth/unauthorized-domain') {
        setErrorMsg('Domain not authorized in Firebase Console. Please add this domain to Firebase Auth authorized domains.');
        return;
      }

      // Friendly fallback message
      setErrorMsg(err?.message || 'Google authorization failed. Please try again.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 animate-fade-in">
      <div 
        className="w-full max-w-[340px] bg-[#16171d] rounded-2xl p-5 shadow-2xl relative border border-white/10 text-[#e3e3e3] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 w-6.5 h-6.5 flex items-center justify-center rounded-full bg-white/5 text-[#9aa0a6] hover:text-white transition cursor-pointer z-10"
          title="Close"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>

        {/* Modal Header */}
        <div className="text-center mb-5 pt-1">
          <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-2.5 p-2 shadow-inner">
            <img src="/logo-icon.svg" alt="BloopX" className="w-8 h-8 object-contain" />
          </div>
          <h2 className="text-[17px] font-semibold text-white tracking-tight mb-1">
            Sign in to BloopX
          </h2>
          <p className="text-[12px] text-[#9ca3af] leading-snug max-w-[280px] mx-auto">
            Authorize with your Google account to access all features, store chat history, and manage your daily token allowance.
          </p>
        </div>

        {/* Error Notification */}
        {errorMsg && (
          <div className="mb-4 p-2.5 bg-red-500/10 border border-red-500/30 rounded-xl flex items-start gap-2 text-[12px] text-red-200">
            <span className="material-symbols-outlined text-[16px] text-red-400 shrink-0 mt-0.5">error</span>
            <span className="leading-tight">{errorMsg}</span>
          </div>
        )}

        {/* Google SSO Login */}
        <div className="space-y-3 pt-1">
          <button
            type="button"
            onClick={handleGoogleSSO}
            disabled={isLoading}
            className="w-full h-11 flex items-center justify-center gap-3 px-4 bg-[#1e2029] hover:bg-[#252833] text-gray-100 rounded-xl transition border border-white/10 hover:border-white/20 cursor-pointer active:scale-[0.98] shadow-sm select-none disabled:opacity-60"
          >
            {isLoading ? (
              <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
            ) : (
              <>
                <svg className="w-4.5 h-4.5 shrink-0 block" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                </svg>
                <span className="text-[13px] font-semibold leading-none inline-block">Continue with Google</span>
              </>
            )}
          </button>

          <p className="text-center text-[10.5px] text-[#71767b] pt-1">
            Secured by Firebase Google Authentication
          </p>
        </div>
      </div>
    </div>
  );
};
