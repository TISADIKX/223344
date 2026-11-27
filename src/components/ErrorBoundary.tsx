import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected error occurred.',
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Application ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let friendlyText = 'Something went wrong while loading your workspace.';
      try {
        const parsed = JSON.parse(this.state.errorMessage);
        if (parsed?.error) {
          friendlyText = parsed.error.includes('permission')
            ? 'Session access was denied for this account. Please sign in again.'
            : parsed.error;
        }
      } catch {
        if (this.state.errorMessage) {
          friendlyText = this.state.errorMessage;
        }
      }

      return (
        <div className="min-h-dvh w-full bg-[#191919] text-[#e3e3e3] flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-[#252525] border border-white/10 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
            <div className="w-11 h-11 rounded-2xl bg-red-500/10 border border-red-500/25 flex items-center justify-center mx-auto text-red-400">
              <span className="material-symbols-outlined text-[22px]">error</span>
            </div>
            <div className="space-y-1.5">
              <h2 className="text-[16px] font-semibold text-white">Unable to continue</h2>
              <p className="text-[12.5px] text-[#9e9e9e] leading-relaxed">{friendlyText}</p>
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full h-9 rounded-xl bg-white text-black text-[13px] font-semibold hover:bg-gray-200 transition cursor-pointer"
            >
              Reload BloopX
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
