import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../src/engine/session";
import {
  deleteAccount,
  loadAnalyticsSessions,
  loadHistory,
  loadProfile,
  loadSessionRecord,
  loadSessionSummaries,
  saveSession,
  updateName,
  updateWeeklyGoal,
} from "../src/account";

vi.mock("../src/auth", () => ({
  getClient: () => null,
  getSession: async () => null,
}));

const SESSION_ID = "2026-11-20T09:00:00.000Z";
const record: SessionRecord = {
  id: SESSION_ID,
  exerciseId: "push-up",
  exerciseName: "Push-up",
  startedAt: SESSION_ID,
  endedAt: SESSION_ID,
  target: { sets: 1, reps: 2 },
  weightKg: null,
  sets: [
    {
      set: 1,
      reps: [
        { durationMs: 1000, faults: [], atMs: 0 },
        { durationMs: 1200, faults: ["hips"], atMs: 1000 },
      ],
      partials: 0,
    },
  ],
};
const stats = {
  totalReps: 2,
  cleanReps: 1,
  cleanPct: 50,
  avgRepMs: 1100,
  partials: 0,
  sets: [],
  faultReps: [],
  notes: [],
};

function memoryStorage(throws = false): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => {
      if (throws) throw new Error("storage unavailable");
      return values.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (throws) throw new Error("storage unavailable");
      values.set(key, value);
    },
    removeItem: (key) => {
      if (throws) throw new Error("storage unavailable");
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guest account persistence", () => {
  it("saves finished sessions locally for history, streaks and reports", async () => {
    await expect(saveSession(record, stats)).resolves.toBe(true);

    await expect(loadHistory()).resolves.toMatchObject([
      {
        id: SESSION_ID,
        exerciseId: "push-up",
        targetSets: 1,
        targetReps: 2,
        weightKg: null,
      },
    ]);
    await expect(loadSessionSummaries()).resolves.toMatchObject([
      { exerciseId: "push-up", totalReps: 2, cleanReps: 1 },
    ]);
    await expect(loadAnalyticsSessions()).resolves.toMatchObject([
      { id: SESSION_ID, totalReps: 2, cleanReps: 1 },
    ]);
    await expect(loadSessionRecord(SESSION_ID)).resolves.toEqual(record);
  });

  it("provides and persists a local guest profile", async () => {
    await expect(loadProfile()).resolves.toMatchObject({
      id: "guest",
      name: "Guest",
      weeklyGoal: 3,
      plan: "free",
    });

    await expect(updateName("guest", "Alex")).resolves.toBe(true);
    await expect(updateWeeklyGoal("guest", 4)).resolves.toBe(true);
    await expect(loadProfile()).resolves.toMatchObject({
      id: "guest",
      name: "Alex",
      weeklyGoal: 4,
    });
  });

  it("clears local guest data when deleting the guest profile", async () => {
    await saveSession(record, stats);
    await updateName("guest", "Alex");

    await expect(deleteAccount()).resolves.toBe(true);
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(loadProfile()).resolves.toMatchObject({
      name: "Guest",
      weeklyGoal: 3,
    });
  });

  it("returns empty data instead of rejecting when local storage is unavailable", async () => {
    vi.stubGlobal("localStorage", memoryStorage(true));

    await expect(saveSession(record, stats)).resolves.toBe(false);
    await expect(loadHistory()).resolves.toEqual([]);
    await expect(loadSessionSummaries()).resolves.toEqual([]);
    await expect(loadAnalyticsSessions()).resolves.toEqual([]);
    await expect(loadProfile()).resolves.toMatchObject({
      name: "Guest",
      weeklyGoal: 3,
    });
    await expect(updateName("guest", "Alex")).resolves.toBe(false);
    await expect(updateWeeklyGoal("guest", 4)).resolves.toBe(false);
    await expect(deleteAccount()).resolves.toBe(false);
  });
});
