import React, { useState, useRef, useEffect } from 'react';
import { ChatSession, UserAccount } from '../types';

interface HistorySidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelectSession: (session: ChatSession) => void;
  onNewChat: () => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteSession: (sessionId: string) => void;
  currentUser?: UserAccount | null;
}

export const HistorySidebar: React.FC<HistorySidebarProps> = ({
  isOpen,
  onClose,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onDeleteSession,
}) => {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [heldSessionId, setHeldSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const holdTimerRef = useRef<any>(null);

  // Reset transient row states when mini panel closes
  useEffect(() => {
    if (!isOpen) {
      setEditingSessionId(null);
      setHeldSessionId(null);
      setSearchQuery('');
    }
  }, [isOpen]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  // Clear held delete state on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.held-delete-container')) {
        setHeldSessionId(null);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const sortedSessions = [...sessions]
    .sort((a, b) => {
      const timeA = a.updatedAt || a.createdAt || 0;
      const timeB = b.updatedAt || b.createdAt || 0;
      return timeB - timeA;
    })
    .filter((s) =>
      searchQuery.trim()
        ? s.title.toLowerCase().includes(searchQuery.trim().toLowerCase())
        : true
    );

  const handleStartRename = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
    setHeldSessionId(null);
  };

  const handleSaveRename = (sessionId: string) => {
    if (editingTitle.trim()) {
      onRenameSession(sessionId, editingTitle.trim());
    }
    setEditingSessionId(null);
    setEditingTitle('');
  };

  const handleDelete = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteSession(sessionId);
    setHeldSessionId(null);
  };

  const startHold = (sessionId: string) => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      setHeldSessionId(sessionId);
    }, 450);
  };

  const cancelHold = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  if (!isOpen) return null;

  return (
    <aside
      id="history-sidebar"
      aria-label="Chat history"
      className="absolute left-0 top-10 z-50 w-[264px] sm:w-[284px] max-w-[calc(100vw-2rem)] bg-[#16181f] border border-white/10 rounded-2xl p-2.5 shadow-2xl flex flex-col select-none transition-[transform,opacity] duration-150 origin-top-left"
    >
      {/* Compact Top Bar with Brand and New Button */}
      <div className="flex items-center justify-between gap-2 px-1 pb-2 border-b border-white/[0.08] shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <img src="/logo-icon.svg" alt="BloopX" className="w-4.5 h-4.5 object-contain shrink-0" />
          <span className="text-[13px] font-semibold text-white tracking-tight truncate">History</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            id="sidebar-new-chat-btn"
          type="button"
          onClick={() => {
            onNewChat();
            onClose();
          }}
          className="h-7 px-3 rounded-lg bg-[#22252f] hover:bg-[#2b2f3c] border border-white/10 text-[12px] font-medium text-white flex items-center justify-center active:scale-[0.96] transition cursor-pointer shrink-0"
          title="New chat"
          aria-label="New chat"
        >
          <span>New</span>
        </button>

          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition cursor-pointer shrink-0"
            title="Close"
            aria-label="Close history"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      </div>

      {/* Compact Quick Filter when multiple chats exist */}
      {sessions.length > 4 && (
        <div className="pt-2 pb-1 px-0.5 shrink-0">
          <div className="flex items-center gap-1.5 bg-[#0f1117] border border-white/[0.08] rounded-lg px-2.5 h-7">
            <span className="material-symbols-outlined text-[14px] text-[#8e918f]">search</span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter chats..."
              className="w-full bg-transparent text-[11.5px] text-white placeholder-[#8e918f] outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-gray-400 hover:text-white flex items-center cursor-pointer"
                title="Clear filter"
              >
                <span className="material-symbols-outlined text-[13px]">close</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Mini Scrollable History List (No three-dot icon) */}
      <div className="mt-1.5 max-h-[245px] sm:max-h-[280px] overflow-y-auto space-y-0.5">
        {sortedSessions.length === 0 ? (
          <div className="py-6 px-3 flex flex-col items-center justify-center text-center">
            <p className="text-[12px] font-medium text-gray-300">
              {searchQuery.trim() ? 'No matching chats' : 'No recent chats'}
            </p>
            <p className="text-[11px] text-[#8e918f] mt-0.5">
              {searchQuery.trim()
                ? 'Try a different search term.'
                : 'Your conversations will appear here.'}
            </p>
          </div>
        ) : (
          sortedSessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isEditing = editingSessionId === session.id;
            const isHeld = heldSessionId === session.id;

            return (
              <div
                key={session.id}
                onMouseDown={() => startHold(session.id)}
                onMouseUp={cancelHold}
                onMouseLeave={cancelHold}
                onTouchStart={() => startHold(session.id)}
                onTouchEnd={cancelHold}
                onTouchCancel={cancelHold}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setHeldSessionId(session.id);
                }}
                onClick={() => {
                  if (!isEditing && !isHeld) {
                    onSelectSession(session);
                    onClose();
                  }
                }}
                className={`group relative rounded-xl px-2.5 py-1.5 flex items-center justify-between gap-2 transition-colors duration-150 cursor-pointer text-[12.5px] ${
                  isHeld
                    ? 'bg-white/12 text-white'
                    : isActive
                    ? 'bg-white/10 text-white font-medium'
                    : 'text-[#d1d5db] hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {/* Title or Inline Rename */}
                <div className="flex items-center min-w-0 flex-1">
                  {isEditing ? (
                    <div
                      className="flex items-center gap-1 flex-1 min-w-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveRename(session.id);
                          if (e.key === 'Escape') setEditingSessionId(null);
                        }}
                        className="w-full bg-[#0d0f14] border border-white/30 text-white text-[12px] px-2 py-0.5 rounded-md outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveRename(session.id)}
                        className="w-5.5 h-5.5 rounded-md flex items-center justify-center text-emerald-400 hover:bg-emerald-500/10 transition cursor-pointer shrink-0"
                        title="Save"
                      >
                        <span className="material-symbols-outlined text-[14px]">check</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingSessionId(null)}
                        className="w-5.5 h-5.5 rounded-md flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition cursor-pointer shrink-0"
                        title="Cancel"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </div>
                  ) : (
                    <p className="truncate leading-snug">{session.title}</p>
                  )}
                </div>

                {/* Hold Action: Clean Delete Option */}
                {!isEditing && isHeld && (
                  <div
                    className="held-delete-container flex items-center gap-1 shrink-0 z-20"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={(e) => handleDelete(session.id, e)}
                      className="h-6 px-2.5 bg-[#22252f] hover:bg-[#2b2f3c] border border-white/10 text-white hover:text-white rounded-lg flex items-center gap-1 text-[11.5px] font-medium transition cursor-pointer whitespace-nowrap active:scale-[0.96]"
                      title="Delete chat"
                    >
                      <span className="material-symbols-outlined text-[13px]">delete</span>
                      <span>Delete</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setHeldSessionId(null);
                      }}
                      className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition cursor-pointer"
                      title="Cancel"
                    >
                      <span className="material-symbols-outlined text-[13px]">close</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
