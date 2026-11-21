// The signed in user's data: profile and saved sessions. No UI here.
// Every call runs as the user, so the database rules decide what is seen.

import { getClient, getSession } from "./auth";
import type { SessionRecord } from "./engine/session";
import { fromRecord } from "./analytics";
import type { AnalyticsSession } from "./analytics";
import type { HistoryItem } from "./history";
import type { SessionSummary } from "./progress";
import type { SessionStats } from "./ui/summary";

export type Plan = "free" | "premium";

export interface Profile {
  id: string;
  email: string;
  name: string;
  plan: Plan;
  avatarUrl: string | null;
  // Set when the plan comes from a paid Polar subscription. Empty for a plan
  // that was given by hand.
  hasSubscription: boolean;
  premiumUntil: string | null;
  cancelAtPeriodEnd: boolean;
  // Two letters for the avatar, from the full name.
  initials: string;
  // Days a week to train to keep the streak. 3 until set.
  weeklyGoal: number;
}

const PENDING_KEY = "repchek.pendingSessions";
const LOCAL_SESSIONS_KEY = "repchek.localSessions";
const LOCAL_PROFILE_KEY = "repchek.localProfile";
const GUEST_PROFILE_ID = "guest";
// Postgres code for "row already exists".
const DUPLICATE = "23505";
const MAX_ROWS = 5000;

interface SessionRow {
  client_id: string;
  exercise_id: string;
  exercise_name: string;
  started_at: string;
  ended_at: string;
  total_reps: number;
  clean_reps: number;
  record: SessionRecord;
}

interface LocalProfileSettings {
  name: string;
  weeklyGoal: number;
}

function toRow(record: SessionRecord, stats: SessionStats): SessionRow {
  return {
    client_id: record.id,
    exercise_id: record.exerciseId,
    exercise_name: record.exerciseName,
    started_at: record.startedAt,
    ended_at: record.endedAt,
    total_reps: stats.totalReps,
    clean_reps: stats.cleanReps,
    record,
  };
}

function isSessionRow(value: unknown): value is SessionRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Partial<SessionRow>;
  const record = row.record;
  return (
    typeof row.client_id === "string" &&
    typeof row.exercise_id === "string" &&
    typeof row.exercise_name === "string" &&
    typeof row.started_at === "string" &&
    typeof row.ended_at === "string" &&
    typeof row.total_reps === "number" &&
    typeof row.clean_reps === "number" &&
    typeof record === "object" &&
    record !== null &&
    typeof record.id === "string" &&
    typeof record.exerciseId === "string" &&
    typeof record.exerciseName === "string" &&
    typeof record.startedAt === "string" &&
    Array.isArray(record.sets)
  );
}

function readRows(key: string): SessionRow[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const rows: unknown = JSON.parse(raw);
    return Array.isArray(rows) ? rows.filter(isSessionRow) : [];
  } catch {
    return [];
  }
}

function writeRows(key: string, rows: SessionRow[]): boolean {
  try {
    if (rows.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

function readPending(): SessionRow[] {
  return readRows(PENDING_KEY);
}

function writePending(rows: SessionRow[]): void {
  writeRows(PENDING_KEY, rows);
}

function localSessionRows(): SessionRow[] {
  const unique = new Map<string, SessionRow>();
  for (const row of [
    ...readRows(LOCAL_SESSIONS_KEY),
    ...readPending(),
  ]) {
    unique.set(row.client_id, row);
  }
  return [...unique.values()].sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
}

function saveLocalSession(row: SessionRow): boolean {
  const rows = localSessionRows().filter((saved) => saved.client_id !== row.client_id);
  return writeRows(LOCAL_SESSIONS_KEY, [...rows, row]);
}

function localProfileSettings(): LocalProfileSettings {
  try {
    const raw = localStorage.getItem(LOCAL_PROFILE_KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (typeof value === "object" && value !== null) {
        const settings = value as Partial<LocalProfileSettings>;
        return {
          name: typeof settings.name === "string" ? settings.name : "",
          weeklyGoal:
            typeof settings.weeklyGoal === "number" &&
            Number.isInteger(settings.weeklyGoal) &&
            settings.weeklyGoal >= 1 &&
            settings.weeklyGoal <= 7
              ? settings.weeklyGoal
              : 3,
        };
      }
    }
  } catch {
    // Use guest defaults when local profile storage is unavailable or invalid.
  }
  return { name: "", weeklyGoal: 3 };
}

function saveLocalProfileSettings(
  settings: LocalProfileSettings,
): boolean {
  try {
    localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function localProfile(): Profile {
  const settings = localProfileSettings();
  const name = settings.name || "Guest";
  return {
    id: GUEST_PROFILE_ID,
    email: "",
    name,
    plan: "free",
    avatarUrl: null,
    hasSubscription: false,
    premiumUntil: null,
    cancelAtPeriodEnd: false,
    weeklyGoal: settings.weeklyGoal,
    initials: initialsOf(name),
  };
}

function localSessionSummaries(): SessionSummary[] {
  return localSessionRows().map((row) => ({
    exerciseId: row.exercise_id,
    exerciseName: row.exercise_name,
    startedAt: row.started_at,
    totalReps: row.total_reps,
    cleanReps: row.clean_reps,
  }));
}

function localHistory(): HistoryItem[] {
  return localSessionRows().map((row) => ({
    id: row.client_id,
    exerciseId: row.exercise_id,
    exerciseName: row.exercise_name,
    startedAt: row.started_at,
    totalReps: row.total_reps,
    cleanReps: row.clean_reps,
    targetSets: row.record.target?.sets,
    targetReps: row.record.target?.reps,
    weightKg: row.record.weightKg,
  }));
}

function localAnalyticsSessions(): AnalyticsSession[] {
  const sessions: AnalyticsSession[] = [];
  for (const row of localSessionRows()) {
    try {
      sessions.push(fromRecord(row.record));
    } catch {
      // Skip a corrupted local record without blocking the rest of the history.
    }
  }
  return sessions;
}

async function insertRow(row: SessionRow): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    const { error } = await client.from("sessions").insert(row);
    return !error || error.code === DUPLICATE;
  } catch {
    return false;
  }
}

// Saves a finished session. If it cannot reach the server, it is kept on
// the device and sent next time. Returns true when it is saved now.
export async function saveSession(
  record: SessionRecord,
  stats: SessionStats,
): Promise<boolean> {
  if (stats.totalReps === 0) return true;
  const row = toRow(record, stats);
  if (!getClient()) return saveLocalSession(row);
  if (await insertRow(row)) {
    // It may have been waiting on the device from an earlier try.
    writePending(readPending().filter((p) => p.client_id !== row.client_id));
    return true;
  }
  const pending = readPending();
  if (!pending.some((p) => p.client_id === row.client_id)) {
    writePending([...pending, row]);
  }
  return false;
}

// Sends anything that was kept on the device.
export async function flushPending(): Promise<void> {
  if (!getClient()) return;
  const pending = readPending();
  if (pending.length === 0) return;
  const left: SessionRow[] = [];
  for (const row of pending) {
    if (!(await insertRow(row))) left.push(row);
  }
  writePending(left);
}

export function clearPending(): void {
  writePending([]);
}

// "Frank Ndung'u" -> "FN", "frank@email.com" -> "FR".
export function initialsOf(text: string): string {
  const words = text
    .split(/[\s@._-]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length >= 2 && !text.includes("@")) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return (words[0] ?? "R").slice(0, 2).toUpperCase();
}

export async function loadProfile(): Promise<Profile | null> {
  const client = getClient();
  if (!client) return localProfile();
  const session = await getSession();
  if (!session?.user?.id) return localProfile();
  const user = session.user;
  let name = "";
  let plan: Plan = "free";
  let hasSubscription = false;
  let premiumUntil: string | null = null;
  let cancelAtPeriodEnd = false;
  let weeklyGoal = 3;
  try {
    const { data } = await client
      .from("profiles")
      .select(
        "display_name, plan, premium_until, cancel_at_period_end, polar_subscription_id, weekly_goal",
      )
      .eq("id", user.id)
      .maybeSingle();
    name = data?.display_name ?? "";
    plan = data?.plan === "premium" ? "premium" : "free";
    hasSubscription = Boolean(data?.polar_subscription_id);
    premiumUntil = (data?.premium_until as string | null) ?? null;
    cancelAtPeriodEnd = data?.cancel_at_period_end === true;
    weeklyGoal = Number(data?.weekly_goal) || 3;
  } catch {
    // Offline: fall through with the defaults.
  }
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const email = user.email ?? "";
  return {
    id: user.id,
    email,
    name: name || email.split("@")[0] || "You",
    plan,
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
    hasSubscription,
    premiumUntil,
    cancelAtPeriodEnd,
    weeklyGoal,
    initials: initialsOf(
      (typeof meta.full_name === "string" && meta.full_name) ||
        (typeof meta.name === "string" && meta.name) ||
        name ||
        email,
    ),
  };
}

export async function updateWeeklyGoal(
  id: string,
  goal: number,
): Promise<boolean> {
  const client = getClient();
  if (!client || id === GUEST_PROFILE_ID) {
    const settings = localProfileSettings();
    return saveLocalProfileSettings({ ...settings, weeklyGoal: goal });
  }
  try {
    const { error } = await client
      .from("profiles")
      .update({ weekly_goal: goal })
      .eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

export async function updateName(id: string, name: string): Promise<boolean> {
  const client = getClient();
  if (!client || id === GUEST_PROFILE_ID) {
    const settings = localProfileSettings();
    return saveLocalProfileSettings({ ...settings, name });
  }
  try {
    const { error } = await client
      .from("profiles")
      .update({ display_name: name })
      .eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

// Every saved session, newest first, with only what the maths needs.
export async function loadSessionSummaries(): Promise<SessionSummary[] | null> {
  const client = getClient();
  if (!client) return localSessionSummaries();
  try {
    const { data, error } = await client
      .from("sessions")
      .select("exercise_id, exercise_name, started_at, total_reps, clean_reps")
      .order("started_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error || !data) return null;
    return data.map((r) => ({
      exerciseId: r.exercise_id as string,
      exerciseName: r.exercise_name as string,
      startedAt: r.started_at as string,
      totalReps: r.total_reps as number,
      cleanReps: r.clean_reps as number,
    }));
  } catch {
    return null;
  }
}

// Every saved session for the History tab, newest first. The planned sets and
// reps and the weight are read out of the saved record for the Train screen.
// If that part of the query is ever refused, the plain list still loads, so
// History never depends on it.
const HISTORY_COLUMNS =
  "client_id, exercise_id, exercise_name, started_at, total_reps, clean_reps";

export async function loadHistory(): Promise<HistoryItem[] | null> {
  const client = getClient();
  if (!client) return localHistory();
  const ask = (columns: string) =>
    client
      .from("sessions")
      .select(columns)
      .order("started_at", { ascending: false })
      .limit(MAX_ROWS);
  try {
    let { data, error } = await ask(
      `${HISTORY_COLUMNS}, target:record->target, weight:record->weightKg`,
    );
    if (error || !data) {
      ({ data, error } = await ask(HISTORY_COLUMNS));
    }
    if (error || !data) return null;
    return (data as unknown as Record<string, unknown>[]).map((r) => {
      const target = r.target as { sets?: number; reps?: number } | null;
      return {
        id: r.client_id as string,
        exerciseId: r.exercise_id as string,
        exerciseName: r.exercise_name as string,
        startedAt: r.started_at as string,
        totalReps: r.total_reps as number,
        cleanReps: r.clean_reps as number,
        targetSets: target?.sets,
        targetReps: target?.reps,
        weightKg: (r.weight as number | null | undefined) ?? null,
      };
    });
  } catch {
    return null;
  }
}

// The newest saved sessions with everything the analytics need. Heavier than
// the history list, so it is only used for Premium.
const ANALYTICS_ROWS = 500;

export async function loadAnalyticsSessions(): Promise<AnalyticsSession[] | null> {
  const client = getClient();
  if (!client) return localAnalyticsSessions();
  try {
    const { data, error } = await client
      .from("sessions")
      .select("record")
      .order("started_at", { ascending: false })
      .limit(ANALYTICS_ROWS);
    if (error || !data) return null;
    return data.map((r) => fromRecord(r.record as SessionRecord));
  } catch {
    return null;
  }
}

// The full record of one saved session, to reopen its report.
export async function loadSessionRecord(
  clientId: string,
): Promise<SessionRecord | null> {
  const client = getClient();
  if (!client) {
    return (
      localSessionRows().find((row) => row.client_id === clientId)?.record ?? null
    );
  }
  try {
    const { data, error } = await client
      .from("sessions")
      .select("record")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error || !data) return null;
    return data.record as SessionRecord;
  } catch {
    return null;
  }
}

// Deletes the account and everything on it. The database function checks
// who is asking, so it can only ever delete the caller.
export async function deleteAccount(): Promise<boolean> {
  const client = getClient();
  if (!client) {
    try {
      localStorage.removeItem(LOCAL_PROFILE_KEY);
      localStorage.removeItem(LOCAL_SESSIONS_KEY);
      localStorage.removeItem(PENDING_KEY);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const { error } = await client.rpc("delete_my_account");
    return !error;
  } catch {
    return false;
  }
}
