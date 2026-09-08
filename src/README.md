# Behavior Tracker

A personal daily-behavior rating app. You define your own rules — daily habits, numeric metrics, and weekly goals — rate yourself against them each day, and track the trend over time. An AI coach reviews your recent activity and delivers a short, specific nudge each day to help you course-correct before small slips become patterns.

## App Scope

Behavior Tracker helps you turn vague self-improvement intentions into a measurable daily routine:

- **Rate My Day** — check off daily yes/no habits, log numeric values (e.g. hours slept, pages read), and track weekly-count goals, all against rules you define yourself.
- **Rules Editor** — create, edit, and archive the habits/goals you're tracking, including goal type (daily, weekly, numeric) and scoring.
- **History** — charts and a heatmap of past ratings so you can see trends, streaks, and where you're consistently falling short.
- **Weekly Summary** — a rolled-up view of the week's performance across all rules.
- **Focus Timer** — a built-in timer for focused work/study sessions.
- **Deadlines** — track upcoming deadlines with a badge count so nothing slips through unnoticed.
- **AI Daily Nudge** — a one-line, data-grounded coaching message generated each morning from yesterday's actual results (see below).

The app runs both as a web app and as a desktop app (via Electron), backed by Firebase for auth, data storage, and hosting.

## Tech Stack

- **Frontend:** React 19 + Vite, [Recharts](https://recharts.org/) for data visualization
- **Desktop:** Electron (wraps the same React app for a native desktop build)
- **Backend / Infra:** Firebase — Authentication (Google sign-in), Cloud Firestore (per-user rules/ratings/nudges), Cloud Functions (Node.js), and Firebase Hosting
- **AI:** Google Gemini (`@google/generative-ai`), called from a Firebase Cloud Function
- **Tooling:** ESLint

## How AI Helps Analyze Daily Behavior and Improve Decisions

Each day, a Cloud Function (`dailyNudge` / `dailyNudgeScheduled` in `functions/index.js`) builds a compact, plain-English summary of the previous day's ratings — what habits were completed vs. missed, logged numeric values, weekly-goal progress, and any free-text note you left. That summary, not raw data, is sent to **Gemini**, which is prompted to act as a terse, upbeat coach and return exactly one short (under 15 words) motivational line that references something *specific* from your actual behavior — not a generic platitude.

This closes the loop between tracking and acting:

1. **Pattern grounding** — because the prompt is built from your real completed/missed rules and logged numbers, the nudge reflects your actual patterns instead of generic advice.
2. **Timely delivery** — nudges are pre-generated every morning by a scheduled function (and cached per user/day in Firestore) so the coaching message is ready the moment you open the app, encouraging same-day corrective action rather than after-the-fact reflection.
3. **Low friction** — a single short sentence is designed to be read in passing, nudging the day's decisions (e.g. "you skipped the gym twice this week — lace up today") without demanding the user analyze charts themselves.
4. **Efficient reuse** — results are cached per user per day so the same insight isn't regenerated (or re-billed) if the app is reopened multiple times in a day.

Over time, this turns the app's historical data (via the History and Weekly Summary views) plus the AI's daily framing into a feedback loop: track → get a targeted nudge → adjust the day's decisions → see the change reflected in tomorrow's data.

## Project Structure

```
src/
  App.jsx                 # Tab navigation + auth gate
  firebase.js              # Firebase app/auth/functions init
  components/
    RateMyDay.jsx          # Daily rating UI + AI nudge banner
    RulesEditor.jsx         # Define/edit tracked habits & goals
    HistoryCharts.jsx       # Trend charts + heatmap
    WeeklySummary.jsx       # Weekly roll-up view
    FocusTimer.jsx          # Focus/study session timer
    Deadlines.jsx           # Deadline tracking
    Login.jsx               # Google sign-in
  hooks/
    useDeadlines.js
electron/                  # Electron main/preload for the desktop build
functions/
  index.js                 # Cloud Functions: dailyNudge (Gemini) + scheduler
```

## Getting Started

```bash
npm install
npm run dev            # run the web app (Vite dev server)
npm run electron:dev   # run the desktop (Electron) build in dev mode
npm run build           # production build
```

Firebase Functions live in `functions/` and require a `GEMINI_API_KEY` secret configured via Firebase (`firebase functions:secrets:set GEMINI_API_KEY`) to enable the AI daily nudge.
