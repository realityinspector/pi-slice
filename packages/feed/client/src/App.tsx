import { useState, useEffect, useRef, useCallback } from 'react';
import './app.css';

// --- Types ---

interface FeedComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

interface FeedPost {
  id: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  content: string;
  timestamp: string;
  likes: number;
  likedByMe?: boolean;
  comments: FeedComment[];
}

type OnboardingStep =
  | 'welcome'
  | 'api-key-check'
  | 'model-selection'
  | 'workspace-setup'
  | 'first-task'
  | 'complete';

interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  apiKeyValid: boolean;
  modelsAvailable: number;
  selectedModels: { director: string; worker: string; steward: string };
  workspaceName?: string;
}

interface AgentStatus {
  name: string;
  role: string;
  status: string;
  task?: string;
}

interface TaskData {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignedTo?: string;
  createdAt: string;
}

interface StatusData {
  agents: AgentStatus[];
  activePlan: string | null;
  repoName: string;
  tasks?: { open: number; inProgress: number; completed: number; total: number };
}

interface WorkspaceData {
  repoName: string;
  branch: string;
  dirtyFiles: number;
}

interface ContextPill {
  type: 'file' | 'pr' | 'issue' | 'branch';
  label: string;
}

// --- Helpers ---

function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const ROLE_COLORS: Record<string, string> = {
  director: '#F59E0B',
  worker: '#3B82F6',
  steward: '#10B981',
  human: '#8B5CF6',
  operator: '#a78bfa',
  system: '#6B7280',
};

const ROLE_BG: Record<string, string> = {
  director: 'rgba(245,158,11,0.15)',
  worker: 'rgba(59,130,246,0.15)',
  steward: 'rgba(16,185,129,0.15)',
  human: 'rgba(139,92,246,0.15)',
  operator: 'rgba(167,139,250,0.15)',
  system: 'rgba(107,114,128,0.15)',
};

function avatarColor(name: string): string {
  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

/** Parse context pills from post content */
function extractContextPills(content: string, agentRole?: string): ContextPill[] {
  const pills: ContextPill[] = [];
  const seen = new Set<string>();

  // File references: common extensions
  const fileRe = /(?:^|\s)(\S+\.(?:ts|tsx|js|jsx|json|css|html|md|py|go|rs|yaml|yml|toml|sh|sql))\b/gi;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(content)) !== null) {
    const f = m[1];
    if (!seen.has('file:' + f)) {
      seen.add('file:' + f);
      pills.push({ type: 'file', label: f });
    }
  }

  // PR references
  const prRe = /PR\s*#(\d+)/gi;
  while ((m = prRe.exec(content)) !== null) {
    const key = 'pr:' + m[1];
    if (!seen.has(key)) {
      seen.add(key);
      pills.push({ type: 'pr', label: 'PR #' + m[1] });
    }
  }

  // Issue / task references: #NNN (but not inside words)
  const issueRe = /(?:^|\s)#(\d{1,6})\b/g;
  while ((m = issueRe.exec(content)) !== null) {
    const key = 'issue:' + m[1];
    if (!seen.has(key)) {
      seen.add(key);
      pills.push({ type: 'issue', label: '#' + m[1] });
    }
  }

  // Branch references (for workers)
  if (agentRole === 'worker') {
    const branchRe = /(?:branch|checkout|merge)\s+[`"']?([a-zA-Z0-9/_-]{3,40})[`"']?/gi;
    while ((m = branchRe.exec(content)) !== null) {
      const key = 'branch:' + m[1];
      if (!seen.has(key)) {
        seen.add(key);
        pills.push({ type: 'branch', label: m[1] });
      }
    }
  }

  return pills;
}

const ONBOARDING_MODAL_STEPS: OnboardingStep[] = [
  'welcome',
  'api-key-check',
  'model-selection',
  'workspace-setup',
];

const ONBOARDING_STORAGE_KEY = 'slice-onboarding-complete';
const HINT_BAR_STORAGE_KEY = 'slice-hint-bar-seen';

// --- Agent mention definitions ---

const AGENT_MENTIONS = [
  { mention: '@director', label: 'Director', desc: 'Plan tasks, break down goals, reprioritize' },
  { mention: '@worker', label: 'Worker', desc: 'Assign coding tasks, fix bugs, implement features' },
  { mention: '@steward', label: 'Steward', desc: 'Review PRs, merge branches, scan docs' },
  { mention: '@all', label: 'All', desc: 'Broadcast to all agents' },
];

// --- Onboarding Components ---

function OnboardingDots({ currentStep }: { currentStep: OnboardingStep }) {
  const stepIndex = ONBOARDING_MODAL_STEPS.indexOf(currentStep);
  return (
    <div className="onboarding-dots">
      {ONBOARDING_MODAL_STEPS.map((step, i) => (
        <span
          key={step}
          className={`onboarding-dot${i === stepIndex ? ' active' : ''}${i < stepIndex ? ' completed' : ''}`}
        />
      ))}
    </div>
  );
}

function OnboardingWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="onboarding-step">
      <div className="onboarding-icon">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <rect width="48" height="48" rx="12" fill="#3B82F6" fillOpacity="0.15" />
          <path d="M14 24L22 32L34 16" stroke="#3B82F6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="onboarding-title">Welcome to Slice</h2>
      <p className="onboarding-subtitle">Social feed for coding agents</p>
      <p className="onboarding-desc">
        Your social dashboard where AI agents plan, code,
        review, and merge — and you're part of the conversation.
      </p>
      <button className="onboarding-btn" onClick={onNext}>
        Get Started <span className="btn-arrow">{'\u2192'}</span>
      </button>
    </div>
  );
}

function OnboardingConnectionCheck({
  state,
  onNext,
}: {
  state: OnboardingState;
  onNext: () => void;
}) {
  const [checking, setChecking] = useState(true);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setChecking(false);
      setConnected(state.apiKeyValid || state.modelsAvailable > 0);
    }, 1200);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (!checking && connected) {
      const timer = setTimeout(onNext, 1500);
      return () => clearTimeout(timer);
    }
  }, [checking, connected, onNext]);

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-title">
        {checking ? 'Checking OpenRouter...' : connected ? 'Connection Verified' : 'Checking OpenRouter...'}
      </h2>
      <div className="onboarding-checks">
        <div className={`check-item${!checking && connected ? ' checked' : ''}`}>
          <span className="check-icon">{!checking && connected ? '\u2713' : '\u2022'}</span>
          <span>
            {!checking && connected
              ? `Connected \u2014 ${state.modelsAvailable || 352} models available`
              : 'Connecting to OpenRouter...'}
          </span>
        </div>
        <div className={`check-item${!checking && connected ? ' checked' : ''}`}>
          <span className="check-icon">{!checking && connected ? '\u2713' : '\u2022'}</span>
          <span>Director: {state.selectedModels.director}</span>
        </div>
        <div className={`check-item${!checking && connected ? ' checked' : ''}`}>
          <span className="check-icon">{!checking && connected ? '\u2713' : '\u2022'}</span>
          <span>Worker: {state.selectedModels.worker}</span>
        </div>
        <div className={`check-item${!checking && connected ? ' checked' : ''}`}>
          <span className="check-icon">{!checking && connected ? '\u2713' : '\u2022'}</span>
          <span>Steward: {state.selectedModels.steward}</span>
        </div>
      </div>
      {checking && <div className="onboarding-spinner" />}
      {!checking && connected && (
        <button className="onboarding-btn" onClick={onNext}>
          Continue <span className="btn-arrow">{'\u2192'}</span>
        </button>
      )}
      {!checking && !connected && (
        <p className="onboarding-error">
          Could not connect. Check your OPENROUTER_API_KEY and restart.
        </p>
      )}
    </div>
  );
}

function OnboardingWorkspace({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="onboarding-step">
      <h2 className="onboarding-title">Your Workspace</h2>
      <div className="onboarding-channels">
        <div className="channel-item">
          <span className="channel-hash">#</span>
          <div>
            <span className="channel-name">general</span>
            <span className="channel-desc">Main feed for all activity</span>
          </div>
        </div>
        <div className="channel-item">
          <span className="channel-hash">#</span>
          <div>
            <span className="channel-name">tasks</span>
            <span className="channel-desc">Task updates and assignments</span>
          </div>
        </div>
        <div className="channel-item">
          <span className="channel-hash">#</span>
          <div>
            <span className="channel-name">cross-talk</span>
            <span className="channel-desc">Cross-instance federation</span>
          </div>
        </div>
      </div>
      <p className="onboarding-ready">
        Director agent <strong>"alice"</strong> is ready.
      </p>
      <button className="onboarding-btn" onClick={onFinish}>
        Open Feed <span className="btn-arrow">{'\u2192'}</span>
      </button>
    </div>
  );
}

function OnboardingModal({
  state,
  onComplete,
  onSkip,
}: {
  state: OnboardingState;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>(state.currentStep);

  const advanceServer = useCallback(async () => {
    try {
      await fetchWithTimeout('/api/onboarding/advance', { method: 'POST' });
    } catch {
      // non-critical
    }
  }, []);

  const handleNext = useCallback(() => {
    advanceServer();
    const idx = ONBOARDING_MODAL_STEPS.indexOf(step);
    if (idx < ONBOARDING_MODAL_STEPS.length - 1) {
      setStep(ONBOARDING_MODAL_STEPS[idx + 1]);
    } else {
      onComplete();
    }
  }, [step, advanceServer, onComplete]);

  const handleSkip = useCallback(async () => {
    try {
      await fetchWithTimeout('/api/onboarding/skip', { method: 'POST' });
    } catch {
      // non-critical
    }
    onSkip();
  }, [onSkip]);

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <button className="onboarding-skip" onClick={handleSkip} title="Skip onboarding">
          {'\u2715'}
        </button>

        <div className="onboarding-body">
          {step === 'welcome' && <OnboardingWelcome onNext={handleNext} />}
          {(step === 'api-key-check' || step === 'model-selection') && (
            <OnboardingConnectionCheck state={state} onNext={handleNext} />
          )}
          {step === 'workspace-setup' && <OnboardingWorkspace onFinish={handleNext} />}
        </div>

        <OnboardingDots currentStep={step} />
      </div>
    </div>
  );
}

function FirstTaskBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="first-task-banner">
      <span className="first-task-text">
        Try posting <strong>"@director build a hello world app"</strong> to create your first task.
      </span>
      <button className="first-task-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

// --- Part 1: Mentions Cheat Sheet Bar ---

function HintBar({ onInsertMention }: { onInsertMention: (mention: string) => void }) {
  const [expanded, setExpanded] = useState(() => {
    return !localStorage.getItem(HINT_BAR_STORAGE_KEY);
  });

  const toggle = () => {
    setExpanded((prev) => {
      if (prev) {
        localStorage.setItem(HINT_BAR_STORAGE_KEY, 'true');
      }
      return !prev;
    });
  };

  const handleClick = (mention: string) => {
    onInsertMention(mention + ' ');
    localStorage.setItem(HINT_BAR_STORAGE_KEY, 'true');
  };

  return (
    <div className="hint-bar">
      <button className="hint-bar-toggle" onClick={toggle}>
        <span className="hint-bar-label">{'\uD83D\uDCA1'} Quick actions</span>
        <span className={`hint-bar-chevron${expanded ? ' expanded' : ''}`}>{'\u203A'}</span>
      </button>
      {expanded && (
        <div className="hint-bar-grid">
          {AGENT_MENTIONS.map((a) => (
            <button
              key={a.mention}
              className="hint-bar-item"
              onClick={() => handleClick(a.mention)}
            >
              <span className="hint-mention">{a.mention}</span>
              <span className="hint-desc"> — {a.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Part 2: Context Pills ---

function ContextPillsDisplay({ pills }: { pills: ContextPill[] }) {
  if (pills.length === 0) return null;

  const icon = (type: string) => {
    switch (type) {
      case 'file': return '\uD83D\uDCC4';
      case 'branch': return '\uD83C\uDF3F';
      default: return '';
    }
  };

  return (
    <span className="context-pills">
      {pills.map((pill, i) => (
        <span key={i} className={`context-pill context-pill-${pill.type}`}>
          {icon(pill.type) ? <span className="pill-icon">{icon(pill.type)}</span> : null}
          {pill.label}
        </span>
      ))}
    </span>
  );
}

// --- Task List Overlay ---

function TaskList({ tasks, onClose }: { tasks: TaskData[]; onClose: () => void }) {
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} style={{ maxHeight: '70vh' }}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span>Tasks</span>
          <button onClick={onClose}>{'\u2715'}</button>
        </div>
        <div className="sheet-body">
          {tasks.map((t: TaskData) => (
            <div key={t.id} className="task-item">
              <span className={`task-status task-status-${t.status}`}>
                {t.status === 'completed' ? '\u2713' : t.status === 'in_progress' ? '\u25D0' : t.status === 'failed' ? '\u2717' : '\u25CB'}
              </span>
              <div className="task-info">
                <strong>{t.title}</strong>
                {t.assignedTo && <span className="task-assignee">{'\u2192'} {t.assignedTo}</span>}
              </div>
            </div>
          ))}
          {tasks.length === 0 && <div className="sheet-empty">No tasks yet. @mention the director to create one.</div>}
        </div>
      </div>
    </div>
  );
}

// --- Part 3: Working On Status Bar ---

function StatusBar({ statusData, onShowTasks }: { statusData: StatusData | null; onShowTasks: () => void }) {
  if (!statusData) return null;

  const busyAgents = statusData.agents.filter((a) => a.status !== 'idle');

  return (
    <div className="status-bar">
      <span className="status-item">
        <span className="status-icon">{'\uD83D\uDCC2'}</span>
        {statusData.repoName}
      </span>
      <span className="status-sep">|</span>
      <span className="status-item clickable" onClick={onShowTasks}>
        <span className="status-icon">{'\uD83D\uDCCB'}</span>
        {statusData.tasks?.total || 0} tasks
      </span>
      {statusData.activePlan && (
        <>
          <span className="status-sep">|</span>
          <span className="status-item">
            {statusData.activePlan}
          </span>
        </>
      )}
      {busyAgents.map((a) => (
        <span key={a.name}>
          <span className="status-sep">|</span>
          <span className="status-item">
            <span className="status-icon">{'\uD83E\uDD16'}</span>
            <span className="status-agent-name">{a.name}</span>
            <span className="status-arrow"> {'\u2192'} </span>
            <span className="status-task">{a.task}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

// --- Part 4: @mention dropdown for compose bar ---

function MentionDropdown({
  filter,
  onSelect,
  visible,
}: {
  filter: string;
  onSelect: (mention: string) => void;
  visible: boolean;
}) {
  if (!visible) return null;

  const filtered = AGENT_MENTIONS.filter((a) =>
    a.mention.toLowerCase().includes(filter.toLowerCase()) ||
    a.label.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) return null;

  return (
    <div className="mention-dropdown">
      {filtered.map((a) => (
        <button
          key={a.mention}
          className="mention-dropdown-item"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(a.mention);
          }}
        >
          <span className="mention-dd-name">{a.mention}</span>
          <span className="mention-dd-role">{a.label}</span>
          <span className="mention-dd-desc">{a.desc}</span>
        </button>
      ))}
    </div>
  );
}

// --- Components ---

function PostCard({
  post,
  onLike,
  onOpenComments,
}: {
  post: FeedPost;
  onLike: (id: string) => void;
  onOpenComments: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const MAX_CHARS = 240;
  const needsTruncation = post.content.length > MAX_CHARS;
  const displayContent =
    expanded || !needsTruncation
      ? post.content
      : post.content.slice(0, MAX_CHARS) + '\u2026';

  const roleColor = ROLE_COLORS[post.agentRole || ''] || '#6B7280';
  const roleBg = ROLE_BG[post.agentRole || ''] || 'rgba(107,114,128,0.15)';
  const agentName = post.agentName || 'Anonymous';
  const pills = extractContextPills(post.content, post.agentRole);

  return (
    <article className="post-card">
      <div className="post-header">
        <div className="avatar" style={{ background: avatarColor(agentName) }}>
          {agentName[0].toUpperCase()}
        </div>
        <div className="post-meta">
          <span className="agent-name">{agentName}</span>
          {post.agentRole && (
            <span
              className="role-badge"
              style={{ color: roleColor, background: roleBg }}
            >
              {post.agentRole}
            </span>
          )}
          <span className="timestamp">{timeAgo(post.timestamp)}</span>
          <ContextPillsDisplay pills={pills} />
        </div>
      </div>

      <div className="post-content">
        <pre>{displayContent}</pre>
        {needsTruncation && !expanded && (
          <button className="read-more" onClick={() => setExpanded(true)}>
            Read more
          </button>
        )}
        {expanded && needsTruncation && (
          <button className="read-more" onClick={() => setExpanded(false)}>
            Show less
          </button>
        )}
      </div>

      <div className="post-actions">
        <button
          className={`action-btn like-btn${post.likedByMe ? ' liked' : ''}`}
          onClick={() => onLike(post.id)}
        >
          <span className="action-icon">{post.likedByMe ? '\u2764' : '\u2661'}</span>
          <span className="action-count">{post.likes || ''}</span>
        </button>
        <button className="action-btn" onClick={() => onOpenComments(post.id)}>
          <span className="action-icon">{'\uD83D\uDCAC'}</span>
          <span className="action-count">
            {post.comments.length || ''}
          </span>
        </button>
      </div>
    </article>
  );
}

function CommentSheet({
  post,
  onClose,
}: {
  post: FeedPost;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [comments, setComments] = useState<FeedComment[]>(post.comments);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!text.trim()) return;
    try {
      const res = await fetchWithTimeout(`/api/feed/${post.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, authorName: 'User' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const comment: FeedComment = await res.json();
      setComments((prev) => [...prev, comment]);
      setText('');
    } catch (err) {
      console.warn('Comment submit failed:', err);
    }
  };

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span>Comments</span>
          <button onClick={onClose}>{'\u2715'}</button>
        </div>
        <div className="sheet-body">
          {comments.length === 0 && (
            <div className="sheet-empty">No comments yet.</div>
          )}
          {comments.map((c) => (
            <div key={c.id} className="comment">
              <span className="comment-author">{c.authorName}</span>
              <span className="comment-time">{timeAgo(c.timestamp)}</span>
              <p>{c.content}</p>
            </div>
          ))}
        </div>
        <div className="sheet-input">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Add a comment\u2026"
          />
          <button onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// --- DM Components ---

function DirectorDM() {
  const [messages, setMessages] = useState<Array<{role: 'user'|'agent', content: string, timestamp: string}>>([]);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sendMessage = async () => {
    if (!input.trim()) return;
    const userMsg = { role: 'user' as const, content: input, timestamp: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    try {
      const res = await fetchWithTimeout('/api/dm/director', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Find the agent's response (last message with role 'agent')
      if (data.messages) {
        const agentMsg = data.messages[data.messages.length - 1];
        if (agentMsg?.role === 'agent') {
          setMessages(prev => [...prev, agentMsg]);
        }
      }
    } catch (err) {
      console.warn('DM send failed:', err);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="dm-view">
      <div className="dm-header">
        <div className="avatar" style={{ background: '#F59E0B' }}>D</div>
        <div>
          <strong>Director</strong>
          <span className="dm-subtitle">Plan tasks, coordinate agents</span>
        </div>
      </div>
      <div className="dm-messages">
        {messages.length === 0 && (
          <div className="dm-welcome">
            <p>This is your direct line to the Director agent.</p>
            <p>Tell it what you want to build, and it will create a plan.</p>
            <div className="dm-suggestions">
              {['Build a user auth system', 'Review open PRs and triage issues', "What's the current status?"].map(s => (
                <button key={s} className="dm-suggestion" onClick={() => { setInput(s); }}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`dm-bubble ${m.role}`}>
            {m.role === 'agent' && <div className="avatar small" style={{ background: '#F59E0B' }}>D</div>}
            <div className="dm-bubble-content">{m.content}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="compose-bar">
        <div className="compose-inner">
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()}
            placeholder="Message Director..." />
          <button onClick={sendMessage} disabled={!input.trim()} aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentsList({ onSelectAgent }: { onSelectAgent: (name: string) => void }) {
  const agents = [
    { name: 'alice', role: 'director', desc: 'Plans tasks, breaks down goals, assigns to workers', color: '#F59E0B' },
    { name: 'bob', role: 'worker', desc: 'Executes tasks, writes code in isolated worktrees', color: '#3B82F6' },
    { name: 'dave', role: 'worker', desc: 'Executes tasks, writes code in isolated worktrees', color: '#3B82F6' },
    { name: 'carol', role: 'steward', desc: 'Reviews PRs, merges branches, scans documentation', color: '#10B981' },
  ];
  return (
    <div className="agents-list">
      <h2>Agents</h2>
      {agents.map(a => (
        <div key={a.name} className="agent-card">
          <div className="avatar" style={{ background: a.color }}>{a.name[0].toUpperCase()}</div>
          <div className="agent-info">
            <strong>{a.name}</strong>
            <span className="role-badge" style={{ color: a.color, background: a.color + '26' }}>{a.role}</span>
            <p>{a.desc}</p>
          </div>
          <button className="agent-msg-btn" onClick={() => onSelectAgent(a.name)}>Message</button>
        </div>
      ))}
    </div>
  );
}

// --- Main App ---

export function App() {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [commentPostId, setCommentPostId] = useState<string | null>(null);
  const [composeText, setComposeText] = useState('');
  const [agentCount, setAgentCount] = useState(0);
  const [activeTab, setActiveTab] = useState<'feed' | 'director' | 'agents'>('feed');
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const composeRef = useRef<HTMLInputElement>(null);
  const reconnectDelay = useRef(1000);
  const maxReconnectDelay = 30000;

  // Onboarding state
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingState, setOnboardingState] = useState<OnboardingState | null>(null);
  const [showFirstTaskBanner, setShowFirstTaskBanner] = useState(false);

  // Part 3 & 5: status & workspace
  const [statusData, setStatusData] = useState<StatusData | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);

  // Task list overlay
  const [showTasks, setShowTasks] = useState(false);
  const [taskList, setTaskList] = useState<TaskData[]>([]);

  // Part 4: mention dropdown
  const [mentionDropdownVisible, setMentionDropdownVisible] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');

  // Check onboarding on mount
  useEffect(() => {
    const alreadyComplete = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (alreadyComplete) return;

    fetchWithTimeout('/api/onboarding')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (data.active && data.state) {
          setOnboardingState(data.state);
          setShowOnboarding(true);
        }
      })
      .catch((err) => console.warn('Onboarding fetch failed:', err));
  }, []);

  // Fetch status & workspace on mount
  useEffect(() => {
    fetchWithTimeout('/api/status')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => setStatusData(data))
      .catch((err) => console.warn('Status fetch failed:', err));

    fetchWithTimeout('/api/workspace')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => setWorkspace(data))
      .catch((err) => console.warn('Workspace fetch failed:', err));
  }, []);

  // Fetch tasks when overlay is opened
  const fetchTasks = useCallback(() => {
    fetchWithTimeout('/api/tasks')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => { if (Array.isArray(data)) setTaskList(data); })
      .catch((err) => console.warn('Tasks fetch failed:', err));
  }, []);

  const handleShowTasks = useCallback(() => {
    fetchTasks();
    setShowTasks(true);
  }, [fetchTasks]);

  const handleOnboardingComplete = useCallback(() => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    setShowOnboarding(false);
    setShowFirstTaskBanner(true);
  }, []);

  const handleOnboardingSkip = useCallback(() => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    setShowOnboarding(false);
  }, []);

  // Load initial feed
  useEffect(() => {
    fetchWithTimeout('/api/feed')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => { if (Array.isArray(data)) setPosts(data); })
      .catch((err) => console.warn('Feed fetch failed:', err));
  }, []);

  // WebSocket for real-time updates with exponential backoff
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelay.current = 1000; // reset on success
        setConnectionStatus('connected');
        // Refresh posts to catch anything missed during disconnect
        fetchWithTimeout('/api/feed')
          .then(r => r.ok ? r.json() : [])
          .then(data => {
            if (Array.isArray(data)) setPosts(data);
          })
          .catch(() => {});
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'new-post') {
            setPosts((prev) => [msg.data, ...prev]);
          } else if (msg.type === 'reaction') {
            setPosts((prev) =>
              prev.map((p) =>
                p.id === msg.data.postId ? { ...p, likes: msg.data.likes } : p
              )
            );
          } else if (msg.type === 'new-comment') {
            setPosts((prev) =>
              prev.map((p) =>
                p.id === msg.data.postId
                  ? { ...p, comments: [...p.comments, msg.data.comment] }
                  : p
              )
            );
          } else if (msg.type === 'snapshot') {
            if (Array.isArray(msg.data)) setPosts(msg.data);
          } else if (msg.type === 'agent-count') {
            setAgentCount(msg.data);
          }
        } catch (err) {
          console.warn('WebSocket message parse error:', err);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setConnectionStatus('reconnecting');
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, maxReconnectDelay);
        setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after this, triggering reconnect
      };

      return ws;
    }

    const ws = connect();
    return () => {
      ws.close();
    };
  }, []);

  const handleLike = async (postId: string) => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId
          ? { ...p, likedByMe: !p.likedByMe, likes: p.likedByMe ? p.likes - 1 : p.likes + 1 }
          : p
      )
    );
    try {
      const res = await fetchWithTimeout(`/api/feed/${postId}/like`, { method: 'POST' });
      if (!res.ok) console.warn('Like failed:', res.status);
    } catch (err) {
      console.warn('Like request failed:', err);
    }
  };

  const handlePost = async () => {
    if (!composeText.trim()) return;
    try {
      const res = await fetchWithTimeout('/api/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: composeText, agentName: 'User' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setComposeText('');
      setMentionDropdownVisible(false);
    } catch (err) {
      console.warn('Post submit failed:', err);
    }
  };

  // Part 1: insert mention from hint bar or dropdown
  const insertMention = useCallback((mention: string) => {
    setComposeText((prev) => {
      return prev ? prev.trimEnd() + ' ' + mention : mention;
    });
    setMentionDropdownVisible(false);
    composeRef.current?.focus();
  }, []);

  // Part 4: track @mention typing
  const handleComposeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setComposeText(val);

    const atIndex = val.lastIndexOf('@');
    if (atIndex >= 0) {
      const afterAt = val.slice(atIndex + 1);
      if (!afterAt.includes(' ')) {
        setMentionDropdownVisible(true);
        setMentionFilter('@' + afterAt);
        return;
      }
    }
    setMentionDropdownVisible(false);
  };

  const handleMentionSelect = (mention: string) => {
    const atIndex = composeText.lastIndexOf('@');
    if (atIndex >= 0) {
      setComposeText(composeText.slice(0, atIndex) + mention + ' ');
    } else {
      setComposeText(composeText + mention + ' ');
    }
    setMentionDropdownVisible(false);
    composeRef.current?.focus();
  };

  const commentPost = commentPostId
    ? posts.find((p) => p.id === commentPostId) ?? null
    : null;

  return (
    <div className="app">
      {connectionStatus === 'reconnecting' && (
        <div className="connection-banner">Reconnecting...</div>
      )}

      {showOnboarding && onboardingState && (
        <OnboardingModal
          state={onboardingState}
          onComplete={handleOnboardingComplete}
          onSkip={handleOnboardingSkip}
        />
      )}

      <header className="app-header">
        <div className="header-left">
          <img src="/logo.svg" alt="Slice" className="header-logo" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          <div className="header-text">
            <h1>Slice</h1>
            <span className="header-tagline">
              {workspace
                ? `\uD83D\uDCC2 ${workspace.repoName} \u2022 ${workspace.branch}`
                : 'Social feed for coding agents'}
            </span>
          </div>
        </div>
        <div className="header-right">
          <span className="agent-indicator">
            <span className="online-dot" />
            {agentCount > 0 ? `${agentCount} agent${agentCount !== 1 ? 's' : ''}` : 'connecting\u2026'}
          </span>
        </div>
      </header>

      {/* Part 1: Hint bar */}
      <HintBar onInsertMention={insertMention} />

      {/* Part 3: Status bar */}
      <StatusBar statusData={statusData} onShowTasks={handleShowTasks} />

      <nav className="tab-bar">
        <button className={`tab ${activeTab === 'feed' ? 'active' : ''}`} onClick={() => setActiveTab('feed')}>
          {'\uD83D\uDCE2'} Feed
        </button>
        <button className={`tab ${activeTab === 'director' ? 'active' : ''}`} onClick={() => setActiveTab('director')}>
          {'\u2B50'} Director
        </button>
        <button className={`tab ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>
          {'\uD83E\uDD16'} Agents
        </button>
      </nav>

      {activeTab === 'feed' && (
        <>
          <main className="feed">
            {showFirstTaskBanner && (
              <FirstTaskBanner onDismiss={() => setShowFirstTaskBanner(false)} />
            )}
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                onLike={handleLike}
                onOpenComments={setCommentPostId}
              />
            ))}
            {posts.length === 0 && (
              <div className="empty-state">No posts yet. The feed is quiet.</div>
            )}
          </main>

          <div className="compose-bar">
            {/* Part 4: mention dropdown */}
            <MentionDropdown
              filter={mentionFilter}
              onSelect={handleMentionSelect}
              visible={mentionDropdownVisible}
            />
            <div className="compose-inner">
              <input
                ref={composeRef}
                value={composeText}
                onChange={handleComposeChange}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handlePost();
                  }
                  if (e.key === 'Escape') {
                    setMentionDropdownVisible(false);
                  }
                }}
                onBlur={() => {
                  setTimeout(() => setMentionDropdownVisible(false), 150);
                }}
                placeholder="What should we work on? @mention an agent..."
              />
              <button onClick={handlePost} disabled={!composeText.trim()} aria-label="Send">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'director' && <DirectorDM />}

      {activeTab === 'agents' && <AgentsList onSelectAgent={() => setActiveTab('director')} />}

      {commentPost && (
        <CommentSheet
          post={commentPost}
          onClose={() => setCommentPostId(null)}
        />
      )}

      {showTasks && (
        <TaskList
          tasks={taskList}
          onClose={() => setShowTasks(false)}
        />
      )}
    </div>
  );
}
