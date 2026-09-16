const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/https");
const {onSchedule} = require("firebase-functions/scheduler");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {GoogleGenerativeAI} = require("@google/generative-ai");

const NUDGE_TIME_ZONE = "America/New_York";
const RATINGS_HISTORY_LIMIT = 30;
const DEADLINE_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_QUESTION = "What's one small thing you're looking forward to this week?";

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
function addDaysToKey(dateKey, delta) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function prevDateKey(todayKey) {
  return addDaysToKey(todayKey, -1);
}

// Monday-of-the-week key for a given date key, mirroring the client-side
// week-boundary math in RateMyDay.jsx/WeeklySummary.jsx (getWeekDaysForDate/
// getCurrentWeekDays), but done in pure UTC string math for the same reason
// as addDaysToKey above.
function mondayKeyOf(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return addDaysToKey(dateKey, -back);
}
function weekKeys(mondayKey) {
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(mondayKey, i));
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

// Net day score, mirroring the identical logic duplicated client-side in
// HistoryCharts.jsx (heatmap scoreMap) and WeeklySummary.jsx (day score):
// positive-rule points minus negative-rule points minus numeric penalties,
// skipping weekly/count and numeric-input rules. Returns null when the day
// wasn't logged at all (as opposed to logged with a score of 0).
function netScoreForDay(ratingData, ruleMap) {
  if (!ratingData) return null;
  const dailyDone = ratingData.dailyDone || {};
  const scores = ratingData.scores || {};
  const numericScores = ratingData.numericScores || {};
  let pos = 0;
  let neg = 0;
  const src = Object.keys(dailyDone).length > 0 ? dailyDone : scores;
  for (const [ruleId, val] of Object.entries(src)) {
    const rule = ruleMap[ruleId];
    if (!rule || ruleGoalType(rule) === "weekly" || ruleInputType(rule) === "numeric") continue;
    if (rule.type === "positive") pos += val; else neg += val;
  }
  for (const pts of Object.values(numericScores)) {
    if (pts > 0) pos += pts; else neg += -pts;
  }
  return pos - neg;
}

// Turns a users/{uid}/ratings/{yesterday} doc + users/{uid}/rules docs into a
// short plain-English summary Gemini can reference specifics from.
function buildYesterdaySummaryFact(ratingData, rules) {
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

// Detects a rolling "Positive Launcher" streak (consecutive days scoring 40+,
// generalizing the week-bounded award check in HistoryCharts.jsx into a
// continuous streak) and the single longest currently-active per-rule streak.
// Walks backward day-by-day from yesterday; a missing (unlogged) day breaks
// any streak, same as the heatmap treating undefined days as no-data.
function computeStreakFact(ratingsByDate, ruleMap, activeRules, yesterdayKey) {
  let plStreak = 0;
  let cursor = yesterdayKey;
  while (true) {
    const rd = ratingsByDate[cursor];
    if (!rd) break;
    const score = netScoreForDay(rd, ruleMap);
    if (score === null || score < 40) break;
    plStreak++;
    cursor = prevDateKey(cursor);
  }

  let bestRule = null;
  let bestStreak = 0;
  for (const rule of activeRules) {
    if (ruleGoalType(rule) !== "daily" || ruleInputType(rule) !== "yesno" || rule.type !== "positive") continue;
    let streak = 0;
    let c = yesterdayKey;
    while (true) {
      const rd = ratingsByDate[c];
      if (!rd) break;
      const done = rd.dailyDone?.[rule.id] ?? rd.scores?.[rule.id];
      if (!done) break;
      streak++;
      c = prevDateKey(c);
    }
    if (streak > bestStreak) { bestStreak = streak; bestRule = rule; }
  }

  if (plStreak >= 5) {
    return `On a ${plStreak}-day Positive Launcher streak (daily score 40+ each day).`;
  }
  if (plStreak >= 3) {
    return `${plStreak}-day run scoring 40+ points a day - ${5 - plStreak} more day(s) locks in a Positive Launcher streak.`;
  }
  if (bestStreak >= 3 && bestRule) {
    return `${bestRule.name}: a ${bestStreak}-day streak going.`;
  }
  return null;
}

// Nearest not-done deadline due within a 14-day horizon. Reads and filters
// the whole collection in memory (mirrors useDeadlines.js's own no-filter
// read) so this never needs a new Firestore composite index.
function computeNearestDeadlineFact(deadlineDocs, nowMs) {
  let nearest = null;
  for (const d of deadlineDocs) {
    if (d.done) continue;
    const dueMs = d.dueAt?.toDate ? d.dueAt.toDate().getTime() : new Date(d.dueAt).getTime();
    if (!Number.isFinite(dueMs)) continue;
    if (dueMs < nowMs || dueMs > nowMs + DEADLINE_HORIZON_MS) continue;
    if (!nearest || dueMs < nearest.dueMs) nearest = { title: d.title, dueMs };
  }
  if (!nearest) return null;

  const daysUntil = Math.max(0, Math.round((nearest.dueMs - nowMs) / 86400000));
  const when = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
  return `'${nearest.title}' is due ${when}.`;
}

// Ports WeeklySummary.jsx's getGrade thresholds verbatim (S>=50, A>=30,
// B>=10, C>=0, else D) and computes the same average-net-score grade
// server-side from raw ratings, plus a trend comparison against last week.
function getGrade(avgScore) {
  if (avgScore >= 50) return { grade: "S", msg: "LEGENDARY WEEK" };
  if (avgScore >= 30) return { grade: "A", msg: "EXCELLENT WEEK" };
  if (avgScore >= 10) return { grade: "B", msg: "GOOD WEEK" };
  if (avgScore >= 0) return { grade: "C", msg: "AVERAGE WEEK" };
  return { grade: "D", msg: "NEEDS IMPROVEMENT" };
}
function avgNetScore(dateKeys, ratingsByDate, ruleMap) {
  const logged = dateKeys.filter((k) => ratingsByDate[k]);
  if (logged.length === 0) return null;
  const total = logged.reduce((s, k) => s + netScoreForDay(ratingsByDate[k], ruleMap), 0);
  return total / logged.length;
}
function computeWeeklyGradeFact(ratingsByDate, ruleMap, yesterdayKey) {
  const thisMonday = mondayKeyOf(yesterdayKey);
  const daysThisWeek = weekKeys(thisMonday).filter((k) => k <= yesterdayKey);
  const avgThis = avgNetScore(daysThisWeek, ratingsByDate, ruleMap);
  if (avgThis === null) return null;

  const { grade, msg } = getGrade(avgThis);
  let fact = `This week (avg score ${Math.round(avgThis)}) grades ${grade} - ${msg}.`;

  const lastMonday = addDaysToKey(thisMonday, -7);
  const avgLast = avgNetScore(weekKeys(lastMonday), ratingsByDate, ruleMap);
  if (avgLast !== null) {
    const lastGrade = getGrade(avgLast).grade;
    const trend = avgThis > avgLast ? "up" : avgThis < avgLast ? "down" : "steady";
    fact += ` Last week graded ${lastGrade}. Trending ${trend}.`;
  }
  return fact;
}

// Shared sanitizer for every labeled field Gemini returns: strips wrapping
// quotes and hard-caps word count as a safety net in case the model ignores
// the length instruction.
function sanitizeBullet(raw, maxWords = 25) {
  let text = (raw || "").trim();
  text = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!text) return "";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) text = words.slice(0, maxWords).join(" ") + "…";
  return text;
}

// Parses the fixed "LABEL: value" response format into a field map. Case
// insensitive, first match per label wins, and a bare NONE (with optional
// trailing punctuation) is treated as an omitted field.
function parseStructuredResponse(rawText) {
  const fields = { streak: null, deadline: null, weekly: null, ack: null, question: null };
  const seen = new Set();
  const re = /^(STREAK|DEADLINE|WEEKLY|ACK|QUESTION):\s*(.*)$/i;
  for (const rawLine of (rawText || "").split("\n")) {
    const m = rawLine.trim().match(re);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let val = m[2].trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (/^none[.!]?$/i.test(val)) val = "";
    fields[key] = val || null;
  }
  return fields;
}

// Shared by the onCall handler (generates on demand, for whichever user opens
// the app) and the onSchedule job (pre-generates for every active user before
// they open the app). Returns the cached plan as-is; only hits Gemini on a
// cache miss.
async function computeAndCacheNudge(uid, todayKey) {
  const nudgeRef = db.doc(`nudges/${uid}_${todayKey}`);

  const cachedSnap = await nudgeRef.get();
  const cachedBullets = cachedSnap.exists ? cachedSnap.data()?.bullets : null;
  if (Array.isArray(cachedBullets) && cachedBullets.length) {
    return { plan: cachedBullets, cached: true };
  }

  const yesterdayKey = prevDateKey(todayKey);

  const [ratingsSnap, rulesSnap, deadlinesSnap, prevNudgeSnap] = await Promise.all([
    db.collection(`users/${uid}/ratings`).orderBy("date", "desc").limit(RATINGS_HISTORY_LIMIT).get(),
    db.collection(`users/${uid}/rules`).get(),
    db.collection(`users/${uid}/deadlines`).get(),
    db.doc(`nudges/${uid}_${yesterdayKey}`).get(),
  ]);

  const rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const activeRules = rules.filter((r) => !r.deleted);
  const ruleMap = {};
  rules.forEach((r) => { ruleMap[r.id] = r; });

  const ratingsByDate = {};
  ratingsSnap.docs.forEach((d) => { ratingsByDate[d.data().date] = d.data(); });
  const deadlineDocs = deadlinesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const ratingData = ratingsByDate[yesterdayKey] ?? null;
  const streakFact = computeStreakFact(ratingsByDate, ruleMap, activeRules, yesterdayKey);
  const deadlineFact = computeNearestDeadlineFact(deadlineDocs, Date.now());
  const weeklyFact = computeWeeklyGradeFact(ratingsByDate, ruleMap, yesterdayKey);
  const yesterdaySummary = buildYesterdaySummaryFact(ratingData, rules);

  const prevQuestion = prevNudgeSnap.exists ? (prevNudgeSnap.data()?.question || null) : null;
  const noteText = ratingData?.note ? String(ratingData.note).slice(0, 200) : "";

  const prompt = [
    "You are a terse, upbeat habit-tracking coach speaking directly to the user (\"you\"). " +
      "Based on the facts below, reply with EXACTLY five labeled lines in this format and nothing else:",
    "STREAK: <one short line, under 25 words, or NONE>",
    "DEADLINE: <one short line, under 25 words, or NONE>",
    "WEEKLY: <one short line, under 25 words, or NONE>",
    "ACK: <one short line, under 25 words, or NONE>",
    "QUESTION: <one new, short, open-ended personal question, under 25 words>",
    "",
    "Rules:",
    "- Only write real content for STREAK/DEADLINE/WEEKLY if their fact below isn't \"(none)\" - " +
      "otherwise write NONE exactly for that line.",
    "- No quotes, no emoji, no hashtags, no markdown - just the line after each label (icons are added separately).",
    "- ACK: if \"Previous question\" is \"(none)\", write NONE. Otherwise briefly acknowledge/react to the user's " +
      "note below (their answer) - if it's blank, gently note they skipped it - staying upbeat either way.",
    "- QUESTION: always ask a fresh, short, open-ended personal reflection question (not necessarily about habits), " +
      "different from the previous question.",
    "",
    `Streak fact: ${streakFact ?? "(none)"}`,
    `Deadline fact: ${deadlineFact ?? "(none)"}`,
    `Weekly fact: ${weeklyFact ?? "(none)"}`,
    `Previous question: ${prevQuestion ?? "(none)"}`,
    `User's note (answer to previous question): ${noteText || "(left blank)"}`,
    `Yesterday's activity summary: ${yesterdaySummary}`,
  ].join("\n");

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 1024,
    },
  });
  const rawText = result.response.text();
  logger.info("computeAndCacheNudge: raw Gemini response", {
    uid,
    rawText,
    finishReason: result.response.candidates?.[0]?.finishReason,
    usage: result.response.usageMetadata,
  });

  const parsed = parseStructuredResponse(rawText);
  logger.info("computeAndCacheNudge: parsed fields", { uid, parsed });

  if (!parsed.streak && !parsed.deadline && !parsed.weekly && !parsed.ack && !parsed.question) {
    throw new Error("Gemini returned no usable fields.");
  }

  const bullets = [];
  if (streakFact) {
    const text = sanitizeBullet(parsed.streak);
    if (text) bullets.push({ type: "streak", icon: "🔥", text });
  }
  if (deadlineFact) {
    const text = sanitizeBullet(parsed.deadline);
    if (text) bullets.push({ type: "deadline", icon: "📅", text });
  }
  if (weeklyFact) {
    const text = sanitizeBullet(parsed.weekly);
    if (text) bullets.push({ type: "weekly", icon: "📈", text });
  }
  const ackText = parsed.ack ? sanitizeBullet(parsed.ack) : "";
  const questionText = sanitizeBullet(parsed.question) || DEFAULT_QUESTION;
  bullets.push({
    type: "reflection",
    icon: "💭",
    text: [ackText, questionText].filter(Boolean).join(" "),
  });

  await nudgeRef.set({
    uid,
    date: todayKey,
    sourceDate: yesterdayKey,
    question: questionText,
    bullets,
    model: "gemini-3.6-flash",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { plan: bullets, cached: false };
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
    const { plan, cached } = await computeAndCacheNudge(uid, todayKey);
    return { plan, cached, date: todayKey };
  } catch (err) {
    logger.error("dailyNudge: failed to generate plan", err);
    throw new HttpsError("internal", "Could not generate today's plan right now.");
  }
});

// Pre-generates today's plan for every user who has set up rules, so it's
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
