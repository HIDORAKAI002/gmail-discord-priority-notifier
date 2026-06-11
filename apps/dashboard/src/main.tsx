import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { gsap } from "gsap";
import {
  Activity,
  BarChart3,
  Bell,
  CalendarDays,
  CheckCircle2,
  FileText,
  Globe2,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  Mail,
  MailCheck,
  MailWarning,
  Map as MapIcon,
  Palette,
  Pencil,
  Plus,
  Reply,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
  X,
  Zap
} from "lucide-react";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import "./styles.css";

type ThemeName = "dark" | "light" | "minimal" | "glass";
type SeverityLevel = "NORMAL" | "IMPORTANT" | "CRITICAL";
type PageName = "overview" | "insights" | "graphs" | "map" | "priorities" | "logs" | "replies" | "otps" | "settings";

type Rule = {
  id: string;
  accountId: string;
  accountEmail?: string;
  pattern: string;
  action: string;
  description?: string | null;
  createdAt: string;
};

type LogRow = {
  id: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  senderAddress: string | null;
  recipientAddress: string | null;
  senderDomain: string | null;
  subjectPreview: string | null;
  snippetPreview: string | null;
  bodyPreview: string | null;
  disposition: string;
  category: string;
  kind: string;
  ensembleScore: number;
  wasNotified: boolean;
  userFeedback: string | null;
  requiresResponse: boolean;
  isOtp: boolean;
  processedAt: string;
  gmailUrl: string;
  accountEmail: string;
  location: { country: string; code: string; location: string; count: number };
};

type Stats = {
  totals: { processed: number; important: number; spam: number; used: number; low_value: number; duplicate: number; replies: number; otps: number };
  timeline: Array<{ date: string; processed: number; important: number; spam: number; used: number }>;
  by_category: Array<{ category: string; _count: number; _avg: { ensembleScore: number | null } }>;
  segments: Array<{ name: string; count: number; percent: number }>;
  locations: Array<{ country: string; code: string; location: string; count: number }>;
  activity: Array<{ date: string; count: number; level: number }>;
  streaks: { current: number; longest: number };
  rules: Rule[];
  recent: LogRow[];
};

type Account = {
  id: string;
  email: string;
  status: string;
  connectedAt: string;
  lastSyncAt: string | null;
  watchExpiresAt?: string | null;
  syncRequestedAt?: string | null;
  pushEnabled?: boolean;
  preferences: { dmEnabled: boolean; dmMinLevel: SeverityLevel };
  stats: { emails_processed: number };
};

type WhatsappSettings = {
  configured: boolean;
  globalConfigured: boolean;
  ownConfigured: boolean;
  hasOwnApiKey: boolean;
  baseUrl: string;
  sessionId: string;
  agentEnabled: boolean;
  number: string;
  enabled: boolean;
};

type LogFilters = {
  accountId: string;
  disposition: string;
  kind: string;
  from: string;
  to: string;
  search: string;
};

const tokenKey = "mailsync_token";
const themeKey = "mailsync_theme";
const mapUrl = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const colors = ["#16796f", "#f2b84b", "#e45d4f", "#6b7280", "#4c956c", "#3a86a8", "#a98467", "#7c6a92"];

const navItems: Array<{ page: PageName; label: string; icon: React.ReactNode }> = [
  { page: "overview", label: "Overview", icon: <LayoutDashboard /> },
  { page: "insights", label: "Insights", icon: <Activity /> },
  { page: "graphs", label: "Graphs", icon: <BarChart3 /> },
  { page: "map", label: "Map", icon: <MapIcon /> },
  { page: "priorities", label: "Priorities", icon: <Zap /> },
  { page: "logs", label: "Logs", icon: <ListFilter /> },
  { page: "replies", label: "Replies", icon: <Reply /> },
  { page: "otps", label: "OTPs", icon: <KeyRound /> },
  { page: "settings", label: "Settings", icon: <Settings /> }
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem(tokenKey);
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers }
  });
  if (response.status === 401) {
    localStorage.removeItem(tokenKey);
    window.dispatchEvent(new CustomEvent("mailsync-auth-expired"));
    throw new Error("Session expired. Sign in again; your saved mail data is still in MySQL.");
  }
  if (!response.ok) throw new Error((await response.json().catch(() => undefined))?.error ?? response.statusText);
  return response.json() as Promise<T>;
}

function App() {
  const [page, setPage] = useState<PageName>("overview");
  const [theme, setTheme] = useState<ThemeName>(() => (localStorage.getItem(themeKey) as ThemeName) || "dark");
  const [stats, setStats] = useState<Stats | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [whatsapp, setWhatsapp] = useState<WhatsappSettings | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [replies, setReplies] = useState<LogRow[]>([]);
  const [otps, setOtps] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(() => Boolean(localStorage.getItem(tokenKey)));
  const [otp, setOtp] = useState("");
  const [gmailCallback, setGmailCallback] = useState<{ email: string; hint?: string } | null>(null);
  const legalRoute = location.pathname === "/privacy" || location.pathname === "/terms" ? location.pathname : null;
  const isDiscordConnected = hasSession;

  async function loadAll() {
    const [nextStats, nextAccounts, nextWhatsapp, nextLogs, nextReplies, nextOtps] = await Promise.all([
      request<Stats>("/api/stats"),
      request<{ accounts: Account[] }>("/api/accounts"),
      request<WhatsappSettings>("/api/whatsapp"),
      request<{ logs: LogRow[] }>("/api/logs?limit=160"),
      request<{ replies: LogRow[] }>("/api/replies"),
      request<{ otps: LogRow[] }>("/api/otps")
    ]);
    setStats(nextStats);
    setAccounts(nextAccounts.accounts);
    setWhatsapp(nextWhatsapp);
    setLogs(nextLogs.logs);
    setReplies(nextReplies.replies);
    setOtps(nextOtps.otps);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeKey, theme);
  }, [theme]);

  useEffect(() => {
    if (legalRoute) return;
    function handleAuthExpired() {
      setHasSession(false);
      setError(null);
      setStats(null);
      setAccounts([]);
      setWhatsapp(null);
      setLogs([]);
      setReplies([]);
      setOtps([]);
      setNotice("Your dashboard session expired. Your Gmail links and mail logs are still saved; sign in again to view them.");
    }
    window.addEventListener("mailsync-auth-expired", handleAuthExpired);
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    const email = params.get("email");
    const otpHint = params.get("otp_hint") ?? undefined;
    if (token) {
      localStorage.setItem(tokenKey, token);
      setHasSession(true);
      history.replaceState(null, "", "/");
    }
    if (email) {
      setGmailCallback({ email, hint: otpHint });
      setNotice("Gmail OAuth succeeded. Verify the OTP to finish linking.");
      if (otpHint) setOtp(otpHint);
      history.replaceState(null, "", "/");
    }
    if (token || localStorage.getItem(tokenKey)) {
      loadAll().catch((err) => setError(err.message));
    }
    return () => window.removeEventListener("mailsync-auth-expired", handleAuthExpired);
  }, [legalRoute]);

  if (legalRoute) return <LegalPage kind={legalRoute === "/privacy" ? "privacy" : "terms"} />;

  async function loginDiscord() {
    const result = await request<{ auth_url: string }>("/api/auth/discord", { method: "POST", body: "{}" });
    location.href = result.auth_url;
  }

  async function startWhatsappLogin(number: string) {
    await request("/api/auth/whatsapp/init", { method: "POST", body: JSON.stringify({ number }) });
  }

  async function verifyWhatsappLogin(number: string, code: string) {
    const result = await request<{ token: string }>("/api/auth/whatsapp/verify", { method: "POST", body: JSON.stringify({ number, otp: code }) });
    localStorage.setItem(tokenKey, result.token);
    setHasSession(true);
    setNotice("WhatsApp login verified. Connect Gmail to start filtering new mail.");
    await loadAll();
  }

  async function addGmail() {
    const result = await request<{ auth_url: string }>("/api/auth/gmail/init", { method: "POST", body: "{}" });
    location.href = result.auth_url;
  }

  async function verifyOtp() {
    await request("/api/auth/verify-otp", { method: "POST", body: JSON.stringify({ otp }) });
    setNotice("Gmail account linked successfully.");
    setGmailCallback(null);
    setOtp("");
    await loadAll();
  }

  async function deleteRule(id: string) {
    await request(`/api/rules/${id}`, { method: "DELETE" });
    setNotice("Rule removed.");
    await loadAll();
  }

  async function saveRule(rule: Rule, pattern: string, action: string) {
    await request(`/api/rules/${rule.id}`, { method: "PUT", body: JSON.stringify({ pattern, action }) });
    setNotice("Rule updated.");
    await loadAll();
  }

  async function addRule(accountId: string, pattern: string, action: string) {
    const targets = accountId === "all" ? accounts : accounts.filter((account) => account.id === accountId);
    await Promise.all(targets.map((account) => request("/api/rules", { method: "POST", body: JSON.stringify({ accountId: account.id, pattern, action }) })));
    setNotice("Rule added.");
    await loadAll();
  }

  async function markReplied(id: string) {
    await request(`/api/replies/${id}/done`, { method: "POST", body: "{}" });
    setNotice("Reply cleared.");
    await loadAll();
  }

  async function deleteMyData() {
    if (!window.confirm("Delete your MailSync account, linked Gmail data, logs, rules, sessions, and OTP records? This cannot be undone.")) return;
    await request("/api/me", { method: "DELETE" });
    localStorage.removeItem(tokenKey);
    setHasSession(false);
    setStats(null);
    setAccounts([]);
    setWhatsapp(null);
    setLogs([]);
    setReplies([]);
    setOtps([]);
    setNotice(null);
    location.href = "/";
  }

  if (!isDiscordConnected) {
    return <OnboardingPage theme={theme} setTheme={setTheme} loginDiscord={loginDiscord} startWhatsappLogin={startWhatsappLogin} verifyWhatsappLogin={verifyWhatsappLogin} />;
  }

  if (error && !isDiscordConnected) {
    return (
      <main className="center">
        <div className="brand-lock"><MailCheck /></div>
        <h1>MailSync</h1>
        <p>{error}</p>
        <button onClick={loginDiscord}>Connect Discord</button>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <DashboardAtmosphere theme={theme} />
      <aside className="sidebar">
        <div className="brand"><MailCheck /><strong>MailSync</strong></div>
        <nav>
          {navItems.map((item) => (
            <button key={item.page} className={page === item.page ? "active" : ""} onClick={() => setPage(item.page)}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="legal-nav"><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p>Collective inbox intelligence</p>
            <h1>{titleForPage(page)}</h1>
          </div>
          <div className="actions">
            {isDiscordConnected ? <span className="status-pill"><CheckCircle2 />Discord connected</span> : <button onClick={loginDiscord}>Connect Discord</button>}
            {accounts.length ? <span className="status-pill"><Inbox />{accounts.length} mailbox{accounts.length === 1 ? "" : "es"}</span> : <button onClick={addGmail}>Add Gmail</button>}
            {accounts.length > 0 && <button className="ghost" onClick={addGmail}><Plus />Add mailbox</button>}
            <ThemePicker theme={theme} setTheme={setTheme} />
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {gmailCallback && (
          <section className="panel otp-panel">
            <div><h3>Verify {gmailCallback.email}</h3><p>{gmailCallback.hint ? "Testing fallback is enabled, so the code is prefilled." : "Check your Discord DM for the code."}</p></div>
            <input value={otp} onChange={(event) => setOtp(event.target.value)} placeholder="6-digit code" />
            <button onClick={verifyOtp}>Verify Gmail</button>
          </section>
        )}

        <AnimatedPage page={page}>
          {page === "overview" && <OverviewPage stats={stats} accounts={accounts} replies={replies} otps={otps} setPage={setPage} />}
          {page === "insights" && <InsightsPage stats={stats} accounts={accounts} />}
          {page === "graphs" && <GraphsPage stats={stats} />}
          {page === "map" && <MapPage stats={stats} logs={logs} />}
          {page === "priorities" && <PrioritiesPage accounts={accounts} rules={stats?.rules ?? []} addRule={addRule} saveRule={saveRule} deleteRule={deleteRule} />}
          {page === "logs" && <LogsPage accounts={accounts} logs={logs} />}
          {page === "replies" && <RepliesPage replies={replies} markReplied={markReplied} />}
          {page === "otps" && <OtpsPage otps={otps} />}
          {page === "settings" && <SettingsPage theme={theme} setTheme={setTheme} accounts={accounts} whatsapp={whatsapp} reload={loadAll} deleteMyData={deleteMyData} />}
        </AnimatedPage>
      </section>
    </main>
  );
}

function titleForPage(page: PageName) {
  return {
    overview: "Overview",
    insights: "Insights",
    graphs: "Graphs",
    map: "World map",
    priorities: "Priorities",
    logs: "Mail logs",
    replies: "Replies",
    otps: "OTPs",
    settings: "Settings"
  }[page];
}

function AnimatedPage({ page, children }: { page: PageName; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    gsap.fromTo(ref.current.querySelectorAll(".motion-item"), { y: 18, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.035, duration: 0.45, ease: "power2.out" });
  }, [page]);
  return <div ref={ref}>{children}</div>;
}

function OnboardingPage({
  theme,
  setTheme,
  loginDiscord,
  startWhatsappLogin,
  verifyWhatsappLogin
}: {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  loginDiscord: () => Promise<void>;
  startWhatsappLogin: (number: string) => Promise<void>;
  verifyWhatsappLogin: (number: string, code: string) => Promise<void>;
}) {
  const shellRef = useRef<HTMLElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappCode, setWhatsappCode] = useState("");
  const [whatsappStep, setWhatsappStep] = useState<"number" | "code">("number");
  const [whatsappBusy, setWhatsappBusy] = useState(false);
  const [whatsappMessage, setWhatsappMessage] = useState<string | null>(null);
  const themeOptions: Array<{ name: ThemeName; title: string; text: string }> = [
    { name: "glass", title: "Glass", text: "Layered, fluid, high-depth command center." },
    { name: "minimal", title: "Minimal", text: "Quiet black and white with maximum space." },
    { name: "dark", title: "Dark", text: "Dense, calm, operations-first dashboard." },
    { name: "light", title: "Light", text: "Warm light surfaces with strong readability." }
  ];
  const steps = [
    { title: "Connect Discord", text: "Discord becomes the owner account for every inbox you add.", icon: <Bell /> },
    { title: "Link Gmail", text: "Add one mailbox or ten; analytics roll up under the same user.", icon: <Inbox /> },
    { title: "Watch new mail", text: "Only new messages after the watcher starts are eligible for DMs.", icon: <MailCheck /> },
    { title: "Control rules", text: "Tune keywords, muted domains, replies, OTPs, logs, graphs, and maps.", icon: <ListFilter /> }
  ];

  useLayoutEffect(() => {
    if (!shellRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(".onboard-motion", { y: 28, opacity: 0 }, { y: 0, opacity: 1, duration: 0.72, stagger: 0.07, ease: "power3.out" });
      gsap.to(".onboard-wire", { y: -14, duration: 3.8, repeat: -1, yoyo: true, stagger: 0.18, ease: "sine.inOut" });
      gsap.to(".signal-dot", { x: 18, opacity: 0.45, duration: 2.4, repeat: -1, yoyo: true, stagger: 0.22, ease: "sine.inOut" });
    }, shellRef);
    return () => ctx.revert();
  }, []);

  async function startDiscord() {
    setConnecting(true);
    try {
      await loginDiscord();
    } catch {
      setConnecting(false);
    }
  }

  async function startWhatsapp() {
    setWhatsappBusy(true);
    setWhatsappMessage(null);
    try {
      await startWhatsappLogin(whatsappNumber);
      setWhatsappStep("code");
      setWhatsappMessage("Code sent on WhatsApp.");
    } catch (error) {
      setWhatsappMessage(error instanceof Error ? error.message : "Could not send WhatsApp login code.");
    } finally {
      setWhatsappBusy(false);
    }
  }

  async function verifyWhatsapp() {
    setWhatsappBusy(true);
    setWhatsappMessage(null);
    try {
      await verifyWhatsappLogin(whatsappNumber, whatsappCode);
    } catch (error) {
      setWhatsappMessage(error instanceof Error ? error.message : "Could not verify WhatsApp login.");
      setWhatsappBusy(false);
    }
  }

  return (
    <main className="onboarding-shell" ref={shellRef}>
      <FlowCanvas theme={theme} />
      <div className="onboarding-content">
        <nav className="onboarding-nav onboard-motion">
          <a className="onboarding-brand" href="/"><MailCheck /><strong>MailSync</strong></a>
          <div className="onboarding-nav-actions">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <ThemePicker theme={theme} setTheme={setTheme} />
          </div>
        </nav>

        <section className="onboarding-hero">
          <div className="onboarding-copy onboard-motion">
            <span className="eyebrow">Discord-native email command center</span>
            <h1>One Discord account. Every inbox. One clear command center.</h1>
            <p>Connect once, link all Gmail accounts, and let MailSync route only new priority mail into clean Discord cards while the dashboard keeps the full operational record.</p>
            <div className="hero-actions">
              <button onClick={startDiscord} disabled={connecting}>{connecting ? "Opening Discord" : "Connect Discord"}</button>
              <a className="button-link subtle-link" href="/privacy">Data policy</a>
            </div>
            <div className="whatsapp-login-card">
              <div>
                <b>Start with WhatsApp</b>
                <span>Use an OpenWA OTP, then connect Discord and Gmail later.</span>
              </div>
              <div className="whatsapp-login-grid">
                <input value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value)} placeholder="+14155550123" />
                {whatsappStep === "code" && <input value={whatsappCode} onChange={(event) => setWhatsappCode(event.target.value)} placeholder="6-digit code" />}
                {whatsappStep === "number"
                  ? <button className="ghost" onClick={startWhatsapp} disabled={whatsappBusy}>{whatsappBusy ? "Sending" : "Send code"}</button>
                  : <button className="ghost" onClick={verifyWhatsapp} disabled={whatsappBusy}>{whatsappBusy ? "Verifying" : "Verify"}</button>}
              </div>
              {whatsappMessage && <p>{whatsappMessage}</p>}
            </div>
          </div>

          <div className="onboarding-panel onboard-motion">
            <div className="mail-preview-card">
              <div className="mail-preview-head">
                <span />
                <b>Priority mail</b>
                <time>10:18 AM</time>
              </div>
              <h2>Employee contract approval</h2>
              <div className="mail-preview-grid">
                <div><span>From</span><b>ops@company.com</b></div>
                <div><span>To</span><b>founder@company.com</b></div>
              </div>
              <p>Please confirm the approval notes before the finance batch closes today.</p>
              <div className="signal-strip">
                <i className="signal-dot" />
                <i className="signal-dot" />
                <i className="signal-dot" />
                <strong>Discord DM ready</strong>
              </div>
            </div>
            <div className="channel-stack">
              <span className="onboard-wire"><Inbox />Gmail inboxes</span>
              <span className="onboard-wire"><Zap />Priority engine</span>
              <span className="onboard-wire"><Globe2 />Insights map</span>
            </div>
          </div>
        </section>

        <section className="onboarding-grid">
          <div className="onboarding-card theme-select-card onboard-motion">
            <PanelTitle title="Pick your dashboard theme" right="Saved on this browser" icon={<Palette />} />
            <div className="theme-card-grid">
              {themeOptions.map((option) => (
                <button key={option.name} className={`theme-card ${theme === option.name ? "active" : ""}`} onClick={() => setTheme(option.name)}>
                  <span>{option.title}</span>
                  <small>{option.text}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="onboarding-card flow-card onboard-motion">
            <PanelTitle title="How the flow works" right="New mail only" icon={<Activity />} />
            <div className="flow-steps">
              {steps.map((step) => (
                <article key={step.title} className="step-card">
                  {step.icon}
                  <div><b>{step.title}</b><p>{step.text}</p></div>
                </article>
              ))}
            </div>
          </div>

          <div className="onboarding-card ownership-card onboard-motion">
            <PanelTitle title="Your data stays owned by you" right="Self-hosted MySQL" icon={<ShieldAlert />} />
            <p>Settings includes a data deletion panel that removes your Discord profile, Gmail tokens, rules, sessions, OTP logs, and mail records from the MailSync database.</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function FlowCanvas({ theme }: { theme: ThemeName }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasElement = ref.current;
    if (!canvasElement) return;
    const context = canvasElement.getContext("2d");
    if (!context) return;
    const canvas: HTMLCanvasElement = canvasElement;
    const ctx: CanvasRenderingContext2D = context;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animationId = 0;
    let width = 0;
    let height = 0;
    let frame = 0;
    const nodes = Array.from({ length: 34 }, (_, index) => ({
      x: ((index * 37) % 100) / 100,
      y: ((index * 53) % 100) / 100,
      speed: 0.35 + (index % 5) * 0.08,
      phase: index * 0.61
    }));

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      const styles = getComputedStyle(document.documentElement);
      const brand = styles.getPropertyValue("--brand").trim() || "#16796f";
      const gold = styles.getPropertyValue("--brand-2").trim() || "#f2b84b";
      frame += reduceMotion ? 0 : 0.012;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = theme === "minimal" || theme === "light" ? "multiply" : "screen";
      nodes.forEach((node, index) => {
        const x = node.x * width + Math.sin(frame * node.speed + node.phase) * 52;
        const y = node.y * height + Math.cos(frame * node.speed + node.phase) * 42;
        const next = nodes[(index + 7) % nodes.length];
        const nx = next.x * width + Math.sin(frame * next.speed + next.phase) * 52;
        const ny = next.y * height + Math.cos(frame * next.speed + next.phase) * 42;
        const gradient = ctx.createLinearGradient(x, y, nx, ny);
        gradient.addColorStop(0, brand);
        gradient.addColorStop(1, gold);
        ctx.strokeStyle = gradient;
        ctx.globalAlpha = 0.08;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo((x + nx) / 2, y - 80, (x + nx) / 2, ny + 80, nx, ny);
        ctx.stroke();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = index % 3 === 0 ? gold : brand;
        ctx.beginPath();
        ctx.arc(x, y, 1.4 + (index % 4), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (!reduceMotion) animationId = requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", resize);
    };
  }, [theme]);

  return <canvas className="flow-canvas" ref={ref} aria-hidden="true" />;
}

function DashboardAtmosphere({ theme }: { theme: ThemeName }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasElement = ref.current;
    if (!canvasElement) return;
    const context = canvasElement.getContext("2d");
    if (!context) return;
    const canvas: HTMLCanvasElement = canvasElement;
    const ctx: CanvasRenderingContext2D = context;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let raf = 0;
    let width = 0;
    let height = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    const streams = Array.from({ length: 28 }, (_, index) => ({
      x: (index * 91) % 100,
      y: (index * 47) % 100,
      phase: index * 0.37,
      velocity: 0.28 + (index % 6) * 0.05
    }));

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function onMove(event: MouseEvent) {
      targetX = (event.clientX / Math.max(width, 1) - 0.5) * 26;
      targetY = (event.clientY / Math.max(height, 1) - 0.5) * 26;
    }

    function draw() {
      const styles = getComputedStyle(document.documentElement);
      const brand = styles.getPropertyValue("--brand").trim() || "#16796f";
      const accent = styles.getPropertyValue("--brand-2").trim() || "#f2b84b";
      frame += reduceMotion ? 0 : 0.01;
      currentX += (targetX - currentX) * 0.05;
      currentY += (targetY - currentY) * 0.05;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = theme === "light" || theme === "minimal" ? "multiply" : "screen";
      streams.forEach((stream, index) => {
        const drift = Math.sin(frame * stream.velocity + stream.phase);
        const x = (stream.x / 100) * width + currentX + drift * 34;
        const y = (stream.y / 100) * height + currentY + Math.cos(frame + stream.phase) * 26;
        const length = 90 + (index % 4) * 48;
        const gradient = ctx.createLinearGradient(x - length, y, x + length, y + drift * 20);
        gradient.addColorStop(0, "transparent");
        gradient.addColorStop(0.45, index % 3 === 0 ? accent : brand);
        gradient.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.08;
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - length, y);
        ctx.bezierCurveTo(x - length / 2, y - 60, x + length / 2, y + 60, x + length, y + drift * 20);
        ctx.stroke();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = index % 3 === 0 ? accent : brand;
        ctx.beginPath();
        ctx.arc(x, y, 1.5 + (index % 3), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (!reduceMotion) raf = requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
    };
  }, [theme]);

  return <canvas className="dashboard-atmosphere" ref={ref} aria-hidden="true" />;
}

function SignalRoutingLab({ stats }: { stats: Stats | null }) {
  const totals = totalsOrEmpty(stats);
  const labRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!labRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(".lab-node", { y: 18, filter: "blur(10px)", opacity: 0 }, { y: 0, filter: "blur(0px)", opacity: 1, duration: 0.68, stagger: 0.08, ease: "power3.out" });
      gsap.to(".scanner-bar", { xPercent: 140, duration: 2.7, repeat: -1, ease: "none" });
      gsap.to(".crush-plate", { scaleY: 0.58, duration: 1.1, repeat: -1, yoyo: true, ease: "power2.inOut" });
    }, labRef);
    return () => ctx.revert();
  }, []);

  return (
    <section className="panel motion-item signal-lab" ref={labRef}>
      <PanelTitle title="Signal routing lab" right="Live filter animation" icon={<Zap />} />
      <div className="lab-track">
        <article className="lab-node">
          <Inbox />
          <b>{totals.processed}</b>
          <span>Mail inspected</span>
          <i className="mail-packet packet-one" />
          <i className="mail-packet packet-two" />
        </article>
        <article className="lab-node scanner-node">
          <Activity />
          <b>Strict scan</b>
          <span>Signals must stack before a DM fires</span>
          <i className="scanner-bar" />
        </article>
        <article className="lab-node dispatch-node">
          <Bell />
          <b>{totals.important}</b>
          <span>Priority dispatches</span>
          <i className="dispatch-beam" />
        </article>
        <article className="lab-node crush-node">
          <ShieldAlert />
          <b>{totals.spam + totals.low_value}</b>
          <span>Suppressed noise</span>
          <i className="crush-plate top" />
          <i className="crush-plate bottom" />
        </article>
      </div>
    </section>
  );
}

function ThemePicker({ theme, setTheme }: { theme: ThemeName; setTheme: (theme: ThemeName) => void }) {
  return (
    <label className="theme-picker">
      <Palette />
      <select value={theme} onChange={(event) => setTheme(event.target.value as ThemeName)}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="minimal">Minimal</option>
        <option value="glass">Glass</option>
      </select>
    </label>
  );
}

function OverviewPage({ stats, accounts, replies, otps, setPage }: { stats: Stats | null; accounts: Account[]; replies: LogRow[]; otps: LogRow[]; setPage: (page: PageName) => void }) {
  const totals = totalsOrEmpty(stats);
  const segmentData = normalizedSegments(stats);
  return (
    <>
      <section className="overview-grid">
        <MetricCard className="motion-item" label="Emails filtered" value={totals.processed} sub={`${accounts.length} connected mailbox${accounts.length === 1 ? "" : "es"}`} icon={<MailCheck />} />
        <MetricCard className="motion-item" label="Replies waiting" value={replies.length || totals.replies} sub="Clears when you reply" icon={<Reply />} />
        <MetricCard className="motion-item wide-metric" label="Collective mailbox coverage" value={accounts.reduce((sum, item) => sum + item.stats.emails_processed, 0)} sub="All Gmail accounts linked to this Discord user" icon={<Inbox />} action={<button onClick={() => setPage("logs")}>Open logs</button>} />
      </section>

      <section className="reference-grid">
        <div className="panel motion-item usage-panel">
          <PanelTitle title="Email type mix" right={`Types used | ${segmentData.length}`} icon={<Mail />} />
          <TypeRows segments={segmentData} total={totals.processed} />
        </div>
        <div className="panel motion-item streak-panel">
          <PanelTitle title={`${stats?.streaks.current ?? 0} day streak`} right={`Longest streak | ${stats?.streaks.longest ?? 0} days`} icon={<CalendarDays />} />
          <ActivityHeatmap activity={stats?.activity ?? []} />
        </div>
      </section>

      <section className="quick-grid">
        <QuickPanel label="Priority mail" value={totals.important} icon={<Bell />} onClick={() => setPage("priorities")} />
        <QuickPanel label="Bad mail" value={totals.spam + totals.low_value} icon={<ShieldAlert />} onClick={() => setPage("graphs")} />
        <QuickPanel label="OTP inbox" value={otps.length || totals.otps} icon={<KeyRound />} onClick={() => setPage("otps")} />
        <QuickPanel label="Map signal" value={stats?.locations.length ?? 0} icon={<Globe2 />} onClick={() => setPage("map")} />
      </section>

      <SignalRoutingLab stats={stats} />
    </>
  );
}

function InsightsPage({ stats, accounts }: { stats: Stats | null; accounts: Account[] }) {
  const totals = totalsOrEmpty(stats);
  return (
    <section className="insight-layout">
      <div className="panel motion-item">
        <PanelTitle title="Filter commit history" right={`${stats?.activity.length ?? 0} days`} icon={<Activity />} />
        <ActivityHeatmap activity={stats?.activity ?? []} dense />
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Per-mailbox contribution" right={`${totals.processed} total`} icon={<Inbox />} />
        {accounts.map((account) => (
          <div className="account-meter" key={account.id}>
            <div><b>{account.email}</b><span>{account.status.toLowerCase()} | last sync {formatDate(account.lastSyncAt)}</span></div>
            <strong>{account.stats.emails_processed}</strong>
          </div>
        ))}
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Signal answers" right="Collective" icon={<CheckCircle2 />} />
        <InfoLine label="How many days tracked" value={String((stats?.activity ?? []).filter((day) => day.count > 0).length)} />
        <InfoLine label="Emails filtered for this user" value={String(totals.processed)} />
        <InfoLine label="Priority rate" value={`${totals.processed ? Math.round((totals.important / totals.processed) * 100) : 0}%`} />
        <InfoLine label="Needs reply" value={String(totals.replies)} />
      </div>
    </section>
  );
}

function GraphsPage({ stats }: { stats: Stats | null }) {
  const segmentData = normalizedSegments(stats);
  const categoryData = stats?.by_category?.map((row) => ({ name: row.category, count: row._count, avg: Math.round(row._avg.ensembleScore ?? 0) })) ?? [];
  return (
    <section className="graph-grid">
      <div className="panel motion-item graph-wide">
        <PanelTitle title="Daily flow" right="Processed, priority, spam, useful" icon={<BarChart3 />} />
        <ResponsiveContainer width="100%" height={330}>
          <LineChart data={stats?.timeline ?? []}>
            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="4 6" />
            <XAxis dataKey="date" stroke="var(--muted)" tickFormatter={(value) => String(value).slice(5)} />
            <YAxis stroke="var(--muted)" allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle()} />
            <Line type="monotone" dataKey="processed" stroke="#16796f" strokeWidth={3} dot={false} />
            <Line type="monotone" dataKey="important" stroke="#f2b84b" strokeWidth={3} dot={false} />
            <Line type="monotone" dataKey="spam" stroke="#e45d4f" strokeWidth={3} dot={false} />
            <Line type="monotone" dataKey="used" stroke="#6b7280" strokeWidth={3} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Email categories" right="Percent split" icon={<Mail />} />
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie data={segmentData} dataKey="count" nameKey="name" innerRadius={58} outerRadius={95} paddingAngle={3}>
              {segmentData.map((_entry, index) => <Cell key={index} fill={colors[index % colors.length]} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle()} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Importance bands" right="Score distribution" icon={<Activity />} />
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={categoryData}>
            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="4 6" />
            <XAxis dataKey="name" stroke="var(--muted)" />
            <YAxis stroke="var(--muted)" allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle()} />
            <Bar dataKey="count" radius={[8, 8, 2, 2]}>
              {categoryData.map((_entry, index) => <Cell key={index} fill={colors[index % colors.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="panel motion-item graph-wide">
        <PanelTitle title="Stacked usage surface" right="Volume trend" icon={<Activity />} />
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={stats?.timeline ?? []}>
            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="4 6" />
            <XAxis dataKey="date" stroke="var(--muted)" tickFormatter={(value) => String(value).slice(5)} />
            <YAxis stroke="var(--muted)" allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle()} />
            <Area type="monotone" dataKey="used" stackId="1" stroke="#6b7280" fill="#6b728066" />
            <Area type="monotone" dataKey="important" stackId="1" stroke="#f2b84b" fill="#f2b84b66" />
            <Area type="monotone" dataKey="spam" stackId="1" stroke="#e45d4f" fill="#e45d4f66" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function MapPage({ stats, logs }: { stats: Stats | null; logs: LogRow[] }) {
  const locationMap = new Map((stats?.locations ?? []).map((item) => [item.country, item.count]));
  const max = Math.max(...(stats?.locations ?? []).map((item) => item.count), 1);
  return (
    <section className="map-layout">
      <div className="panel motion-item world-panel">
        <PanelTitle title="Email origin map" right="Country borders" icon={<Globe2 />} />
        <ComposableMap projectionConfig={{ scale: 145 }} className="world-map">
          <Geographies geography={mapUrl}>
            {({ geographies }: { geographies: Array<Record<string, unknown>> }) =>
              geographies.map((geo) => {
                const props = geo.properties as { name?: string };
                const count = locationMap.get(props.name ?? "") ?? 0;
                const opacity = count ? 0.25 + (count / max) * 0.75 : 0.08;
                return (
                  <Geography
                    key={String(geo.rsmKey ?? props.name)}
                    geography={geo}
                    fill={count ? `rgba(22, 121, 111, ${opacity})` : "var(--map-idle)"}
                    stroke="var(--map-border)"
                    strokeWidth={0.45}
                    style={{
                      default: { outline: "none" },
                      hover: { fill: "#f2b84b", outline: "none" },
                      pressed: { outline: "none" }
                    }}
                  />
                );
              })
            }
          </Geographies>
        </ComposableMap>
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Top sender countries" right={`${logs.length} logs loaded`} icon={<MapIcon />} />
        {(stats?.locations ?? []).length === 0 ? <p className="muted">No trackable country data yet.</p> : stats?.locations.map((item) => (
          <div className="country-row" key={`${item.country}-${item.location}`}>
            <div><b>{item.country}</b><span>{item.location}</span></div>
            <strong>{item.count}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function PrioritiesPage({ accounts, rules, addRule, saveRule, deleteRule }: { accounts: Account[]; rules: Rule[]; addRule: (accountId: string, pattern: string, action: string) => Promise<void>; saveRule: (rule: Rule, pattern: string, action: string) => Promise<void>; deleteRule: (id: string) => Promise<void> }) {
  const [accountId, setAccountId] = useState("all");
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState("BOOST");
  return (
    <section className="priority-layout">
      <div className="panel motion-item">
        <PanelTitle title="Add priority or suppression rule" right="Applies to one or all mailboxes" icon={<Zap />} />
        <div className="rule-editor">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="all">All mailboxes</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
          </select>
          <input value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="client name, domain, invoice, contract" />
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="BOOST">Boost priority</option>
            <option value="ALWAYS_NOTIFY">Always notify</option>
            <option value="NEVER_NOTIFY">Never notify</option>
            <option value="MARK_SPAM">Mark spam</option>
          </select>
          <button disabled={!pattern.trim() || accounts.length === 0} onClick={async () => { await addRule(accountId, pattern.trim(), action); setPattern(""); }}>Add rule</button>
        </div>
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Active rules" right={`${rules.length} total`} icon={<ListFilter />} />
        <div className="rule-table">
          {rules.length === 0 ? <p className="muted">No rules yet.</p> : rules.map((rule) => <EditableRule key={rule.id} rule={rule} saveRule={saveRule} deleteRule={deleteRule} />)}
        </div>
      </div>
    </section>
  );
}

function EditableRule({ rule, saveRule, deleteRule }: { rule: Rule; saveRule: (rule: Rule, pattern: string, action: string) => Promise<void>; deleteRule: (id: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState(rule.pattern);
  const [action, setAction] = useState(rule.action);
  if (editing) {
    return (
      <div className="rule-row editing">
        <input value={pattern} onChange={(event) => setPattern(event.target.value)} />
        <select value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="BOOST">Boost priority</option>
          <option value="ALWAYS_NOTIFY">Always notify</option>
          <option value="NEVER_NOTIFY">Never notify</option>
          <option value="MARK_SPAM">Mark spam</option>
        </select>
        <button onClick={async () => { await saveRule(rule, pattern, action); setEditing(false); }}>Save</button>
        <button className="icon-button" onClick={() => setEditing(false)}><X /></button>
      </div>
    );
  }
  return (
    <div className="rule-row">
      <div><b>{rule.pattern}</b><span>{rule.accountEmail ?? "Mailbox"} | {rule.action.toLowerCase()}</span></div>
      <button className="icon-button" onClick={() => setEditing(true)}><Pencil /></button>
      <button className="icon-button danger" onClick={() => deleteRule(rule.id)}><Trash2 /></button>
    </div>
  );
}

function LogsPage({ accounts, logs }: { accounts: Account[]; logs: LogRow[] }) {
  const [filters, setFilters] = useState<LogFilters>({ accountId: "all", disposition: "all", kind: "all", from: "", to: "", search: "" });
  const filtered = logs.filter((row) => {
    if (filters.accountId !== "all" && row.accountEmail !== accounts.find((account) => account.id === filters.accountId)?.email) return false;
    if (filters.disposition !== "all" && row.disposition !== filters.disposition) return false;
    if (filters.kind !== "all" && row.kind !== filters.kind) return false;
    if (filters.from && new Date(row.processedAt) < new Date(filters.from)) return false;
    if (filters.to && new Date(row.processedAt) > new Date(filters.to)) return false;
    const haystack = `${row.subjectPreview ?? ""} ${row.snippetPreview ?? ""} ${row.senderAddress ?? ""} ${row.senderDomain ?? ""}`.toLowerCase();
    if (filters.search && !haystack.includes(filters.search.toLowerCase())) return false;
    return true;
  });
  return (
    <section className="logs-layout">
      <div className="panel motion-item">
        <PanelTitle title="Filters" right={`${filtered.length} matched`} icon={<Search />} />
        <div className="filter-grid">
          <select value={filters.accountId} onChange={(event) => setFilters({ ...filters, accountId: event.target.value })}>
            <option value="all">All mailboxes</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
          </select>
          <select value={filters.disposition} onChange={(event) => setFilters({ ...filters, disposition: event.target.value })}>
            <option value="all">All priorities</option>
            <option value="IMPORTANT">Important</option>
            <option value="USED">Useful</option>
            <option value="SPAM">Spam</option>
            <option value="LOW_VALUE">Low value</option>
          </select>
          <select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}>
            <option value="all">All types</option>
            <option value="Reply">Replies</option>
            <option value="OTP">OTPs</option>
            <option value="Priority">Priority</option>
            <option value="Spam">Spam</option>
          </select>
          <input type="datetime-local" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          <input type="datetime-local" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          <input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Search sender, subject, preview" />
        </div>
      </div>
      <MailTable rows={filtered} />
    </section>
  );
}

function RepliesPage({ replies, markReplied }: { replies: LogRow[]; markReplied: (id: string) => Promise<void> }) {
  return (
    <section className="cards-list">
      {replies.length === 0 ? <EmptyPanel icon={<Reply />} title="No replies waiting" text="When the system detects mail that needs your response, it will appear here." /> : replies.map((row) => (
        <article className="panel mail-card motion-item" key={row.id}>
          <div><b>{row.subjectPreview ?? "No subject"}</b><span>{row.senderAddress ?? row.senderDomain} to {row.accountEmail}</span></div>
          <p>{row.snippetPreview ?? "No preview available."}</p>
          <div className="row-actions"><a className="button-link" href={row.gmailUrl} target="_blank" rel="noreferrer">Open Gmail</a><button onClick={() => markReplied(row.id)}><CheckCircle2 />Mark replied</button></div>
        </article>
      ))}
    </section>
  );
}

function OtpsPage({ otps }: { otps: LogRow[] }) {
  return (
    <section className="cards-list">
      {otps.length === 0 ? <EmptyPanel icon={<KeyRound />} title="No OTP mail detected" text="Verification and one-time-code emails will be collected here." /> : otps.map((row) => (
        <article className="panel mail-card motion-item" key={row.id}>
          <div><b>{row.subjectPreview ?? "Verification email"}</b><span>{row.senderAddress ?? row.senderDomain} to {row.accountEmail}</span></div>
          <p>{row.snippetPreview ?? "No preview available."}</p>
          <div className="row-actions"><a className="button-link" href={row.gmailUrl} target="_blank" rel="noreferrer">Open Gmail</a><span className="tag">OTP</span></div>
        </article>
      ))}
    </section>
  );
}

function SettingsPage({
  theme,
  setTheme,
  accounts,
  whatsapp,
  reload,
  deleteMyData
}: {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  accounts: Account[];
  whatsapp: WhatsappSettings | null;
  reload: () => Promise<void>;
  deleteMyData: () => Promise<void>;
}) {
  return (
    <section className="settings-grid">
      <div className="panel motion-item">
        <PanelTitle title="Themes" right="Interface modes" icon={<Palette />} />
        <div className="theme-grid">
          {(["glass", "minimal", "dark", "light"] as ThemeName[]).map((item) => <button key={item} className={theme === item ? "active-choice" : "ghost"} onClick={() => setTheme(item)}>{item}</button>)}
        </div>
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Linked mailboxes" right={`${accounts.length} connected`} icon={<Inbox />} />
        {accounts.map((account) => <InfoLine key={account.id} label={account.email} value={`${account.stats.emails_processed} filtered`} />)}
      </div>
      <div className="panel motion-item">
        <PanelTitle title="Delivery channels" right="Roadmap ready" icon={<Send />} />
        <InfoLine label="Discord" value="Active" />
        <InfoLine label="WhatsApp agent" value={whatsapp?.enabled ? "Active" : "Available"} />
        <InfoLine label="Dashboard digest" value="Available through logs" />
      </div>
      <DiscordSeverityPanel accounts={accounts} reload={reload} />
      <WhatsappConnector whatsapp={whatsapp} reload={reload} />
      <div className="panel danger-panel motion-item">
        <PanelTitle title="Data ownership" right="Permanent delete" icon={<Trash2 />} />
        <p>Delete the Discord-linked MailSync profile, sessions, Gmail tokens, rules, OTP records, and stored mail logs for this account.</p>
        <button className="danger-button" onClick={deleteMyData}><Trash2 />Delete my MailSync data</button>
      </div>
    </section>
  );
}

function DiscordSeverityPanel({ accounts, reload }: { accounts: Account[]; reload: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const severityCopy: Record<SeverityLevel, string> = {
    CRITICAL: "Critical only",
    IMPORTANT: "Important and critical",
    NORMAL: "Normal and above"
  };

  async function save(account: Account, patch: Partial<Account["preferences"]>) {
    setBusyId(account.id);
    setMessage(null);
    try {
      await request(`/api/accounts/${account.id}/preferences`, {
        method: "PUT",
        body: JSON.stringify({ ...account.preferences, ...patch })
      });
      await reload();
      setMessage("Discord DM severity updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update Discord delivery.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="panel motion-item severity-panel">
      <PanelTitle title="Discord DM severity" right="Controls every mailbox" icon={<Bell />} />
      <p>Choose how serious a message must be before MailSync sends a Discord DM. Critical only is the strictest and recommended for noisy inboxes.</p>
      <div className="severity-list">
        {accounts.length === 0 ? <p className="muted">Connect Gmail before configuring delivery severity.</p> : accounts.map((account) => (
          <article className="severity-row" key={account.id}>
            <div>
              <b>{account.email}</b>
              <span>{account.preferences.dmEnabled ? severityCopy[account.preferences.dmMinLevel] : "Discord DMs disabled"}</span>
            </div>
            <label className="toggle-row compact-toggle">
              <input type="checkbox" checked={account.preferences.dmEnabled} onChange={(event) => save(account, { dmEnabled: event.target.checked })} disabled={busyId === account.id} />
              <span>DM</span>
            </label>
            <select value={account.preferences.dmMinLevel} onChange={(event) => save(account, { dmMinLevel: event.target.value as SeverityLevel })} disabled={busyId === account.id || !account.preferences.dmEnabled}>
              <option value="CRITICAL">Critical only</option>
              <option value="IMPORTANT">Important and critical</option>
              <option value="NORMAL">Normal and above</option>
            </select>
          </article>
        ))}
      </div>
      {message && <p className="connector-message">{message}</p>}
    </div>
  );
}

function WhatsappConnector({ whatsapp, reload }: { whatsapp: WhatsappSettings | null; reload: () => Promise<void> }) {
  const [number, setNumber] = useState(whatsapp?.number ?? "");
  const [enabled, setEnabled] = useState(Boolean(whatsapp?.enabled));
  const [agentEnabled, setAgentEnabled] = useState(Boolean(whatsapp?.agentEnabled));
  const [baseUrl, setBaseUrl] = useState(whatsapp?.baseUrl ?? "");
  const [sessionId, setSessionId] = useState(whatsapp?.sessionId ?? "default");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setNumber(whatsapp?.number ?? "");
    setEnabled(Boolean(whatsapp?.enabled));
    setAgentEnabled(Boolean(whatsapp?.agentEnabled));
    setBaseUrl(whatsapp?.baseUrl ?? "");
    setSessionId(whatsapp?.sessionId ?? "default");
    setApiKey("");
  }, [whatsapp?.number, whatsapp?.enabled, whatsapp?.agentEnabled, whatsapp?.baseUrl, whatsapp?.sessionId]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await request("/api/whatsapp", { method: "PUT", body: JSON.stringify({ number, enabled, agentEnabled, baseUrl, sessionId, apiKey }) });
      await reload();
      setMessage("WhatsApp connector saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save WhatsApp settings.");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMessage(null);
    try {
      await request("/api/whatsapp/test", { method: "POST", body: "{}" });
      setMessage("Test WhatsApp message sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not send WhatsApp test.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel motion-item whatsapp-panel">
      <PanelTitle title="WhatsApp connector" right={whatsapp?.configured ? `OpenWA session ${whatsapp.sessionId}` : "OpenWA not configured"} icon={<Send />} />
      <p>Send high-priority email alerts from every linked Gmail account to an alternate WhatsApp number. Use the hosted OpenWA agent or override it with your own self-hosted session.</p>
      <div className="whatsapp-form">
        <label>
          <span>Delivery number</span>
          <input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="+14155550123" />
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>Enable WhatsApp priority alerts</span>
        </label>
      </div>
      <div className="agent-settings">
        <label className="toggle-row">
          <input type="checkbox" checked={agentEnabled} onChange={(event) => setAgentEnabled(event.target.checked)} />
          <span>Use my own OpenWA agent</span>
        </label>
        <div className="whatsapp-form">
          <label>
            <span>OpenWA base URL</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://wa.yourdomain.com" disabled={!agentEnabled} />
          </label>
          <label>
            <span>Session ID</span>
            <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="default" disabled={!agentEnabled} />
          </label>
          <label>
            <span>API key {whatsapp?.hasOwnApiKey ? "(saved)" : ""}</span>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={whatsapp?.hasOwnApiKey ? "Leave blank to keep saved key" : "OpenWA API key"} disabled={!agentEnabled} />
          </label>
        </div>
      </div>
      {!whatsapp?.configured && <p className="warning-text">Add a custom OpenWA agent here, or set the platform-wide OpenWA variables on the server.</p>}
      {message && <p className="connector-message">{message}</p>}
      <div className="row-actions">
        <button onClick={save} disabled={busy}>{busy ? "Saving" : "Save WhatsApp"}</button>
        <button className="ghost" onClick={test} disabled={busy || !whatsapp?.configured || !whatsapp?.enabled}>Send test</button>
      </div>
    </div>
  );
}

function MailTable({ rows }: { rows: LogRow[] }) {
  return (
    <div className="panel motion-item mail-table">
      {rows.length === 0 ? <p className="muted">No logs match this filter.</p> : rows.map((row) => (
        <div className="mail-row" key={row.id}>
          <a href={row.gmailUrl} target="_blank" rel="noreferrer"><b>{row.subjectPreview ?? "No subject"}</b><span>{row.senderAddress ?? row.senderDomain ?? "unknown"} to {row.accountEmail}</span></a>
          <span className={`tag ${row.disposition.toLowerCase()}`}>{row.disposition}</span>
          <span className="tag soft">{row.kind}</span>
          <strong>{row.ensembleScore}</strong>
          <time>{formatDate(row.processedAt)}</time>
        </div>
      ))}
    </div>
  );
}

function TypeRows({ segments, total }: { segments: Array<{ name: string; count: number; percent: number }>; total: number }) {
  const icons: Record<string, React.ReactNode> = {
    Good: <MailCheck />,
    "Not good": <MailWarning />,
    Spam: <ShieldAlert />,
    Promotions: <FileText />,
    Updates: <Bell />,
    Social: <Mail />,
    Forums: <Inbox />,
    OTPs: <KeyRound />,
    "Needs reply": <Reply />
  };
  return (
    <div className="type-rows">
      {segments.map((item) => (
        <div className="type-row" key={item.name}>
          <span>{icons[item.name] ?? <Mail />}<b>{item.name}</b></span>
          <i><em style={{ width: `${Math.max(item.percent, total ? 2 : 0)}%` }}>{item.percent}%</em></i>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

function ActivityHeatmap({ activity, dense = false }: { activity: Array<{ date: string; count: number; level: number }>; dense?: boolean }) {
  const days = activity.length ? activity : Array.from({ length: 126 }, (_, index) => ({ date: String(index), count: 0, level: 0 }));
  return (
    <div className={dense ? "heatmap dense" : "heatmap"}>
      {days.map((day) => <span key={day.date} className={`level-${day.level}`} title={`${day.date}: ${day.count} filtered`} />)}
    </div>
  );
}

function MetricCard({ label, value, sub, icon, action, className = "" }: { label: string; value: number | string; sub: string; icon: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <article className={`metric-card ${className}`}>
      <div><strong>{value}</strong><span>{label}</span></div>
      <hr />
      <div className="metric-foot"><p>{icon}{sub}</p>{action}</div>
    </article>
  );
}

function QuickPanel({ label, value, icon, onClick }: { label: string; value: number; icon: React.ReactNode; onClick: () => void }) {
  return <button className="quick-panel motion-item" onClick={onClick}>{icon}<span>{label}</span><strong>{value}</strong></button>;
}

function PanelTitle({ title, right, icon }: { title: string; right: string; icon: React.ReactNode }) {
  return <div className="panel-title"><div><h3>{title}</h3><span>{right}</span></div>{icon}</div>;
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return <div className="info-line"><span>{label}</span><b>{value}</b></div>;
}

function EmptyPanel({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="panel empty-panel motion-item">{icon}<h3>{title}</h3><p>{text}</p></div>;
}

function totalsOrEmpty(stats: Stats | null): Stats["totals"] {
  return stats?.totals ?? { processed: 0, important: 0, spam: 0, used: 0, low_value: 0, duplicate: 0, replies: 0, otps: 0 };
}

function normalizedSegments(stats: Stats | null) {
  return stats?.segments?.length ? stats.segments : [
    { name: "Good", count: 0, percent: 0 },
    { name: "Spam", count: 0, percent: 0 },
    { name: "Promotions", count: 0, percent: 0 },
    { name: "Updates", count: 0, percent: 0 },
    { name: "Social", count: 0, percent: 0 },
    { name: "Forums", count: 0, percent: 0 }
  ];
}

function formatDate(value: string | null) {
  if (!value) return "never";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function tooltipStyle() {
  return { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" };
}

function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const isPrivacy = kind === "privacy";
  return (
    <main className="legal-shell">
      <section className="legal-hero">
        <a className="legal-brand" href="/"><MailCheck /> MailSync</a>
        <p>MailSync legal center</p>
        <h1>{isPrivacy ? "Privacy Policy" : "Terms of Service"}</h1>
        <span>Effective date: June 10, 2026</span>
      </section>
      {isPrivacy ? <PrivacyPolicy /> : <TermsOfService />}
      <footer className="legal-footer"><a href="/">Dashboard</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><span>Contact: your-support-email@example.com</span></footer>
    </main>
  );
}

function PrivacyPolicy() {
  return (
    <section className="legal-doc">
      <h2>Overview</h2><p>MailSync helps users connect Gmail and Discord so important email signals can be classified and delivered as Discord alerts. This policy explains what information is collected, why it is used, and how users can request deletion.</p>
      <h2>Information We Collect</h2><p>When you connect Discord, MailSync stores your Discord user ID, username, optional email returned by Discord, and session records needed to keep you signed in.</p><p>When you connect Gmail, MailSync stores your Gmail address, Google user ID, encrypted OAuth tokens, email metadata needed for classification, short subject/snippet previews, sender and recipient metadata, classification scores, notification status, and operational logs.</p>
      <h2>How We Use Information</h2><p>MailSync uses connected account data to authenticate you, classify email importance, suppress low-value or spam-like messages, deliver important notifications to Discord, show dashboard analytics, prevent abuse, and troubleshoot service reliability.</p>
      <h2>Google User Data</h2><p>MailSync requests Gmail access only to read mailbox metadata and message content needed to classify email importance and produce notifications requested by the user. MailSync does not sell Google user data, does not use it for advertising, and does not allow humans to read user email except when required for security, abuse investigation, legal compliance, or user-requested support.</p>
      <h2>Data Storage and Security</h2><p>OAuth tokens are encrypted before storage. Authentication sessions and OTP records are hashed or time-limited where practical. MailSync is hosted on a private VPS-backed environment with a MySQL database controlled by the service operator.</p>
      <h2>Data Sharing</h2><p>MailSync sends important email alerts to the Discord account connected by the user. MailSync may also use configured AI providers to classify email content where enabled by the service operator. MailSync does not sell personal information.</p>
      <h2>Retention and Deletion</h2><p>MailSync keeps account records and classification history while an account remains connected. Users may request account disconnection or deletion by contacting support. Deletion requests will be handled within a reasonable period unless retention is required for security, abuse prevention, or legal obligations.</p>
      <h2>Contact</h2><p>For privacy questions or deletion requests, contact the service operator at your-support-email@example.com.</p>
    </section>
  );
}

function TermsOfService() {
  return (
    <section className="legal-doc">
      <h2>Acceptance</h2><p>By using MailSync, you agree to these Terms of Service. If you do not agree, do not connect your Google or Discord accounts to MailSync.</p>
      <h2>Service Description</h2><p>MailSync connects Gmail and Discord to classify email importance, filter low-value messages, display analytics, and send selected email alerts to a user's Discord account.</p>
      <h2>User Responsibilities</h2><p>You are responsible for connecting only accounts you own or are authorized to use, keeping your Discord and Google accounts secure, and using MailSync in compliance with applicable laws and provider terms.</p>
      <h2>Acceptable Use</h2><p>You may not use MailSync to access another person's mailbox without permission, abuse Google or Discord APIs, bypass security controls, send unlawful content, or interfere with the service.</p>
      <h2>Third-Party Services</h2><p>MailSync depends on Google, Discord, hosting, database, and optional AI provider services. Their availability, policy changes, or API limits may affect MailSync behavior.</p>
      <h2>No Warranty</h2><p>MailSync is provided as-is. The service may misclassify email, miss notifications, or experience downtime. Do not rely on MailSync as the only system for urgent, legal, medical, financial, or safety-critical communication.</p>
      <h2>Limitation of Liability</h2><p>To the maximum extent permitted by law, MailSync and its operator are not liable for indirect, incidental, special, consequential, or punitive damages arising from use of the service.</p>
      <h2>Account Removal</h2><p>MailSync access may be suspended or removed for abuse, security risk, provider policy violations, or operational reasons. Users may request disconnection or deletion by contacting support.</p>
      <h2>Contact</h2><p>For terms, support, or account questions, contact the service operator at your-support-email@example.com.</p>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
