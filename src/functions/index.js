const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/https");
const {onSchedule} = require("firebase-functions/scheduler");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {GoogleGenerativeAI} = require("@google/generative-ai");

const NUDGE_TIME_ZONE = "America/New_York";

setGlobalOptions({ maxInstances: 10 });

admin.initializeApp();
const db = admin.firestore();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirrors getRuleGoalType/getRuleInputType in src/src/components/RulesEditor.jsx
// so the summary below groups rules the same way the rating UI does.
function ruleGoalType(rule) {
  return rule.goalType === "numeric" ? "daily" : (rule.goalType ?? "daily");
}
function ruleInputType(rule) {
  if (rule.inputType) return rule.inputType;
  if (rule.goalType === "numeric") return "numeric";
  return rule.goalType === "weekly" ? "count" : "yesno";
}

// Pure string/UTC date math so it never depends on the Cloud Functions
// runtime's local timezone (which won't match the user's device timezone
// that generated `todayKey` in the first place).
function prevDateKey(todayKey) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// YYYY-MM-DD for "today" in a given IANA zone, via Intl rather than manual
// offset math so DST transitions are handled correctly.
function todayKeyInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Turns a users/{uid}/ratings/{yesterday} doc + users/{uid}/rules docs into a
// short plain-English summary Gemini can reference specifics from.
function buildYesterdaySummary(ratingData, rules) {
  if (!ratingData) {
    return "The user logged nothing at all yesterday - no missions were rated.";
  }

  const activeRules = rules.filter((r) => !r.deleted);
  const scores = ratingData.scores || {};
  const numericScores = ratingData.numericScores || {};
  const totalScore =
    Object.values(scores).reduce((a, b) => a + (b || 0), 0) +
    Object.values(numericScores).reduce((a, b) => a + (b || 0), 0);

  const completed = [];
  const missed = [];
  const numericLines = [];
  const weeklyLines = [];

  for (const rule of activeRules) {
    const it = ruleInputType(rule);
    if (ruleGoalType(rule) === "daily" && it === "yesno") {
      if (ratingData.dailyDone?.[rule.id]) completed.push(rule.name);
      else missed.push(rule.name);
    } else if (it === "numeric") {
      const v = ratingData.numericValues?.[rule.id];
      if (v !== undefined && v !== null) {
        numericLines.push(`${rule.name}: ${v}${rule.unit || ""}`);
      }
    } else if (it === "count") {
      const c = ratingData.weeklyDone?.[rule.id] ?? 0;
      if (c > 0) weeklyLines.push(`${rule.name} logged ${c}x`);
    }
  }

  const parts = [`Total score: ${totalScore} pts.`];
  if (completed.length) parts.push(`Completed: ${completed.slice(0, 6).join(", ")}.`);
  if (missed.length) parts.push(`Missed: ${missed.slice(0, 6).join(", ")}.`);
  if (numericLines.length) parts.push(`Logged: ${numericLines.slice(0, 6).join(", ")}.`);
  if (weeklyLines.length) parts.push(`Weekly progress: ${weeklyLines.slice(0, 6).join(", ")}.`);
  if (ratingData.note) parts.push(`User's note: "${String(ratingData.note).slice(0, 200)}".`);

  return parts.join(" ");
}

// Keeps only the first line, strips wrapping quotes, and hard-caps length as
// a safety net in case the model ignores the word-count instruction.
function sanitizeNudge(raw) {
  let text = (raw || "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0] || "";
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 18) text = words.slice(0, 18).join(" ") + "…";
  return text;
}

// Shared by the onCall handler (generates on demand, for whichever user opens
// the app) and the onSchedule job (pre-generates for every active user before
// they open the app). Returns cached text as-is; only hits Gemini on a miss.
async function computeAndCacheNudge(uid, todayKey) {
  const nudgeRef = db.doc(`nudges/${uid}_${todayKey}`);

  const cachedSnap = await nudgeRef.get();
  if (cachedSnap.exists && cachedSnap.data()?.text) {
    return { nudge: cachedSnap.data().text, cached: true };
  }

  const yesterdayKey = prevDateKey(todayKey);

  const [ratingSnap, rulesSnap] = await Promise.all([
    db.doc(`users/${uid}/ratings/${yesterdayKey}`).get(),
    db.collection(`users/${uid}/rules`).get(),
  ]);
  const ratingData = ratingSnap.exists ? ratingSnap.data() : null;
  const rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const summary = buildYesterdaySummary(ratingData, rules);

  const prompt =
    "You are a terse, upbeat habit-tracking coach speaking directly to the user " +
    "(\"you\"). Write exactly ONE short motivational line, under 15 words, that " +
    "references something specific from yesterday's data below. No quotes, no " +
    "emoji, no hashtags - just the line.\n\n" +
    `Yesterday (${yesterdayKey}) summary: ${summary}`;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const rawText = result.response.text();
  logger.info("computeAndCacheNudge: raw Gemini response", {
    uid,
    rawText,
    finishReason: result.response.candidates?.[0]?.finishReason,
    usage: result.response.usageMetadata,
  });
  const nudgeText = sanitizeNudge(rawText);

  if (!nudgeText) {
    throw new Error("Gemini returned an empty nudge.");
  }

  await nudgeRef.set({
    uid,
    date: todayKey,
    sourceDate: yesterdayKey,
    text: nudgeText,
    model: "gemini-2.5-flash",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { nudge: nudgeText, cached: false };
}

exports.dailyNudge = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in to get a nudge.");
  }

  const todayKey = request.data?.todayKey;
  if (typeof todayKey !== "string" || !DATE_KEY_RE.test(todayKey)) {
    throw new HttpsError("invalid-argument", "todayKey must be a YYYY-MM-DD string.");
  }

  try {
    const { nudge, cached } = await computeAndCacheNudge(uid, todayKey);
    return { nudge, cached, date: todayKey };
  } catch (err) {
    logger.error("dailyNudge: failed to generate nudge", err);
    throw new HttpsError("internal", "Could not generate a nudge right now.");
  }
});

// Pre-generates today's nudge for every user who has set up rules, so it's
// already cached by the time they open the app. Skips users with no rules
// (never onboarded) to avoid burning Gemini calls on accounts that only ever
// signed in once.
exports.dailyNudgeScheduled = onSchedule(
  { schedule: "0 6 * * *", timeZone: NUDGE_TIME_ZONE, secrets: [GEMINI_API_KEY] },
  async () => {
    const todayKey = todayKeyInTimeZone(NUDGE_TIME_ZONE);
    const { users } = await admin.auth().listUsers(1000);

    for (const { uid } of users) {
      try {
        const rulesSnap = await db.collection(`users/${uid}/rules`).limit(1).get();
        if (rulesSnap.empty) continue;
        await computeAndCacheNudge(uid, todayKey);
      } catch (err) {
        logger.error("dailyNudgeScheduled: failed for user", { uid, err });
      }
    }
  },
);
